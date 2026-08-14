#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <winternl.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <intrin.h>

#include "detours.h"

namespace {

constexpr DWORD kGuardFailureExitCode = 125;
constexpr char kHookFailureMessage[] =
    "msys-token-guard-hook: failed to initialize required MSYS IPC hooks\r\n";
constexpr char kChildFailureMessage[] =
    "msys-token-guard-hook: failed to inject an MSYS child process\r\n";
constexpr wchar_t kReadyHandleEnvironment[] = L"DSH_MSYS_TOKEN_GUARD_READY_HANDLE";

using RtlAddAccessAllowedAceFn = LONG(NTAPI*)(PACL acl, ULONG revision, ACCESS_MASK mask, PSID sid);
using NtSetInformationTokenFn = NTSTATUS(NTAPI*)(
    HANDLE token, TOKEN_INFORMATION_CLASS information_class, PVOID information, ULONG length);

alignas(DWORD) std::array<BYTE, SECURITY_MAX_SID_SIZE> g_logon_sid{};
alignas(DWORD) std::array<BYTE, SECURITY_MAX_SID_SIZE> g_admin_sid{};
char g_hook_path[MAX_PATH]{};
RtlAddAccessAllowedAceFn g_real_add_access_allowed_ace = nullptr;
NtSetInformationTokenFn g_real_set_information_token = nullptr;
PDETOUR_CREATE_PROCESS_ROUTINEW g_real_create_process_w = CreateProcessW;
void* volatile g_msys_runtime = nullptr;

class UniqueHandle {
 public:
  explicit UniqueHandle(HANDLE value = nullptr) noexcept : value_(value) {}
  ~UniqueHandle() {
    if (value_ != nullptr && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
  }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  [[nodiscard]] HANDLE get() const noexcept { return value_; }

 private:
  HANDLE value_;
};

class LocalAllocation {
 public:
  explicit LocalAllocation(void* value = nullptr) noexcept : value_(value) {}
  ~LocalAllocation() {
    if (value_ != nullptr) LocalFree(value_);
  }
  LocalAllocation(const LocalAllocation&) = delete;
  LocalAllocation& operator=(const LocalAllocation&) = delete;

 private:
  void* value_;
};

void write_diagnostic(const char* message) noexcept {
  HANDLE stderr_handle = GetStdHandle(STD_ERROR_HANDLE);
  if (stderr_handle == nullptr || stderr_handle == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(
      stderr_handle,
      message,
      static_cast<DWORD>(std::strlen(message)),
      &written,
      nullptr);
}

[[noreturn]] void fail_closed() noexcept {
  write_diagnostic(kHookFailureMessage);
  TerminateProcess(GetCurrentProcess(), kGuardFailureExitCode);
  ExitProcess(kGuardFailureExitCode);
}

void signal_guard_ready() {
  wchar_t value[32]{};
  SetLastError(ERROR_SUCCESS);
  const DWORD length = GetEnvironmentVariableW(
      kReadyHandleEnvironment, value, static_cast<DWORD>(std::size(value)));
  if (length == 0) {
    if (GetLastError() == ERROR_ENVVAR_NOT_FOUND) return;
    fail_closed();
  }
  if (length >= std::size(value)) fail_closed();

  wchar_t* end = nullptr;
  const unsigned long long raw_handle = std::wcstoull(value, &end, 16);
  if (raw_handle == 0 || end == value || end == nullptr || *end != L'\0') fail_closed();
  HANDLE ready = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(raw_handle));
  if (SetEnvironmentVariableW(kReadyHandleEnvironment, nullptr) == FALSE ||
      SetEvent(ready) == FALSE) {
    fail_closed();
  }
  CloseHandle(ready);
}

bool capture_process_sids() noexcept {
  HANDLE raw_token = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token) == FALSE) return false;
  UniqueHandle token(raw_token);

  alignas(void*) std::array<BYTE, 512> token_buffer{};
  DWORD returned = 0;
  if (GetTokenInformation(
          token.get(),
          TokenLogonSid,
          token_buffer.data(),
          static_cast<DWORD>(token_buffer.size()),
          &returned) == FALSE ||
      returned < sizeof(TOKEN_GROUPS)) {
    return false;
  }

  const auto* logon_groups = reinterpret_cast<const TOKEN_GROUPS*>(token_buffer.data());
  if (logon_groups->GroupCount != 1 || logon_groups->Groups[0].Sid == nullptr ||
      IsValidSid(logon_groups->Groups[0].Sid) == FALSE) {
    return false;
  }
  if (GetLengthSid(logon_groups->Groups[0].Sid) > g_logon_sid.size() ||
      CopySid(
          static_cast<DWORD>(g_logon_sid.size()),
          g_logon_sid.data(),
          logon_groups->Groups[0].Sid) == FALSE) {
    return false;
  }

  alignas(void*) std::array<BYTE, 4096> restricted_buffer{};
  returned = 0;
  if (GetTokenInformation(
          token.get(),
          TokenRestrictedSids,
          restricted_buffer.data(),
          static_cast<DWORD>(restricted_buffer.size()),
          &returned) == FALSE ||
      returned < sizeof(TOKEN_GROUPS)) {
    return false;
  }
  const auto* restricted = reinterpret_cast<const TOKEN_GROUPS*>(restricted_buffer.data());
  bool logon_is_restricting = false;
  for (DWORD index = 0; index < restricted->GroupCount; ++index) {
    if (restricted->Groups[index].Sid != nullptr &&
        IsValidSid(restricted->Groups[index].Sid) != FALSE &&
        EqualSid(g_logon_sid.data(), restricted->Groups[index].Sid) != FALSE) {
      logon_is_restricting = true;
      break;
    }
  }
  if (!logon_is_restricting) return false;

  DWORD admin_size = static_cast<DWORD>(g_admin_sid.size());
  return CreateWellKnownSid(
             WinBuiltinAdministratorsSid,
             nullptr,
             g_admin_sid.data(),
             &admin_size) != FALSE;
}

bool capture_hook_path(HMODULE module) noexcept {
  wchar_t wide_path[32768]{};
  const DWORD length = GetModuleFileNameW(
      module,
      wide_path,
      static_cast<DWORD>(std::size(wide_path)));
  if (length == 0 || length >= std::size(wide_path) - 1) return false;

  BOOL used_default = FALSE;
  const int converted = WideCharToMultiByte(
      CP_ACP,
      WC_NO_BEST_FIT_CHARS,
      wide_path,
      -1,
      g_hook_path,
      static_cast<int>(std::size(g_hook_path)),
      nullptr,
      &used_default);
  return converted > 0 && used_default == FALSE;
}

bool caller_is_msys_runtime(void* return_address) noexcept {
  void* module = InterlockedCompareExchangePointer(&g_msys_runtime, nullptr, nullptr);
  if (module == nullptr) {
    HMODULE candidate = GetModuleHandleW(L"msys-2.0.dll");
    if (candidate == nullptr) return false;
    void* existing = InterlockedCompareExchangePointer(
        &g_msys_runtime, candidate, nullptr);
    module = existing == nullptr ? candidate : existing;
  }

  const auto* base = static_cast<const BYTE*>(module);
  const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
  if (dos->e_magic != IMAGE_DOS_SIGNATURE || dos->e_lfanew <= 0) return false;
  const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE ||
      nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
      nt->OptionalHeader.SizeOfImage == 0) {
    return false;
  }

  const uintptr_t caller = reinterpret_cast<uintptr_t>(return_address);
  const uintptr_t start = reinterpret_cast<uintptr_t>(base);
  return caller >= start && caller - start < nt->OptionalHeader.SizeOfImage;
}

bool is_current_process_token(HANDLE candidate) noexcept {
  if (candidate == nullptr || candidate == INVALID_HANDLE_VALUE) return false;
  TOKEN_STATISTICS candidate_statistics{};
  DWORD returned = 0;
  if (GetTokenInformation(
          candidate,
          TokenStatistics,
          &candidate_statistics,
          sizeof(candidate_statistics),
          &returned) == FALSE ||
      returned < sizeof(candidate_statistics)) {
    return false;
  }

  HANDLE raw_current = nullptr;
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_current) == FALSE) return false;
  UniqueHandle current(raw_current);
  TOKEN_STATISTICS current_statistics{};
  returned = 0;
  if (GetTokenInformation(
          current.get(),
          TokenStatistics,
          &current_statistics,
          sizeof(current_statistics),
          &returned) == FALSE ||
      returned < sizeof(current_statistics)) {
    return false;
  }
  return candidate_statistics.TokenId.LowPart == current_statistics.TokenId.LowPart &&
      candidate_statistics.TokenId.HighPart == current_statistics.TokenId.HighPart;
}

NTSTATUS NTAPI hooked_set_information_token(
    HANDLE token,
    TOKEN_INFORMATION_CLASS information_class,
    PVOID information,
    ULONG length) noexcept {
  if (information_class == TokenDefaultDacl &&
      caller_is_msys_runtime(_ReturnAddress()) &&
      is_current_process_token(token)) {
    return 0;
  }
  return g_real_set_information_token(token, information_class, information, length);
}

LONG NTAPI hooked_add_access_allowed_ace(
    PACL acl,
    ULONG revision,
    ACCESS_MASK mask,
    PSID sid) noexcept {
  PSID replacement = sid;
  if (sid != nullptr && mask == GENERIC_ALL && IsValidSid(sid) != FALSE &&
      EqualSid(sid, g_admin_sid.data()) != FALSE &&
      caller_is_msys_runtime(_ReturnAddress())) {
    replacement = g_logon_sid.data();
  }
  return g_real_add_access_allowed_ace(acl, revision, mask, replacement);
}

bool token_adjust_default_is_denied(HANDLE process) noexcept {
  HANDLE probe = nullptr;
  if (OpenProcessToken(process, TOKEN_ADJUST_DEFAULT, &probe) == FALSE) {
    return GetLastError() == ERROR_ACCESS_DENIED;
  }
  CloseHandle(probe);
  return false;
}

bool deny_child_token_adjust_default(HANDLE process) noexcept {
  HANDLE raw_token = nullptr;
  if (OpenProcessToken(
          process,
          TOKEN_QUERY | READ_CONTROL | WRITE_DAC,
          &raw_token) == FALSE) {
    return false;
  }
  UniqueHandle token(raw_token);

  alignas(void*) std::array<BYTE, sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE> user_buffer{};
  DWORD returned = 0;
  if (GetTokenInformation(
          token.get(),
          TokenUser,
          user_buffer.data(),
          static_cast<DWORD>(user_buffer.size()),
          &returned) == FALSE ||
      returned < sizeof(TOKEN_USER)) {
    return false;
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(user_buffer.data());
  if (user->User.Sid == nullptr || IsValidSid(user->User.Sid) == FALSE) return false;

  PACL current_dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD status = GetSecurityInfo(
      token.get(),
      SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      &current_dacl,
      nullptr,
      &descriptor);
  LocalAllocation descriptor_owner(descriptor);
  if (status != ERROR_SUCCESS || current_dacl == nullptr ||
      IsValidAcl(current_dacl) == FALSE) {
    return false;
  }

  EXPLICIT_ACCESSW deny{};
  deny.grfAccessPermissions = TOKEN_ADJUST_DEFAULT;
  deny.grfAccessMode = DENY_ACCESS;
  deny.grfInheritance = NO_INHERITANCE;
  deny.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  deny.Trustee.TrusteeType = TRUSTEE_IS_USER;
  deny.Trustee.ptstrName = static_cast<LPWSTR>(user->User.Sid);

  PACL hardened_dacl = nullptr;
  status = SetEntriesInAclW(1, &deny, current_dacl, &hardened_dacl);
  LocalAllocation hardened_owner(hardened_dacl);
  if (status != ERROR_SUCCESS || hardened_dacl == nullptr) return false;
  status = SetSecurityInfo(
      token.get(),
      SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      hardened_dacl,
      nullptr);
  return status == ERROR_SUCCESS && token_adjust_default_is_denied(process);
}

void discard_child(PROCESS_INFORMATION* process_information) noexcept {
  if (process_information == nullptr) return;
  if (process_information->hProcess != nullptr) {
    TerminateProcess(process_information->hProcess, kGuardFailureExitCode);
    WaitForSingleObject(process_information->hProcess, 5'000);
  }
  if (process_information->hThread != nullptr) CloseHandle(process_information->hThread);
  if (process_information->hProcess != nullptr) CloseHandle(process_information->hProcess);
  *process_information = {};
}

BOOL WINAPI hooked_create_process_w(
    LPCWSTR application_name,
    LPWSTR command_line,
    LPSECURITY_ATTRIBUTES process_attributes,
    LPSECURITY_ATTRIBUTES thread_attributes,
    BOOL inherit_handles,
    DWORD creation_flags,
    LPVOID environment,
    LPCWSTR current_directory,
    LPSTARTUPINFOW startup_info,
    LPPROCESS_INFORMATION process_information) noexcept {
  const bool caller_requested_suspension = (creation_flags & CREATE_SUSPENDED) != 0;
  const BOOL created = DetourCreateProcessWithDllExW(
      application_name,
      command_line,
      process_attributes,
      thread_attributes,
      inherit_handles,
      creation_flags | CREATE_SUSPENDED,
      environment,
      current_directory,
      startup_info,
      process_information,
      g_hook_path,
      g_real_create_process_w);
  if (created == FALSE) {
    const DWORD code = GetLastError();
    write_diagnostic(kChildFailureMessage);
    SetLastError(code);
    return FALSE;
  }

  if (!deny_child_token_adjust_default(process_information->hProcess)) {
    discard_child(process_information);
    write_diagnostic(kChildFailureMessage);
    SetLastError(ERROR_ACCESS_DENIED);
    return FALSE;
  }
  if (!caller_requested_suspension && ResumeThread(process_information->hThread) ==
          static_cast<DWORD>(-1)) {
    const DWORD code = GetLastError();
    discard_child(process_information);
    write_diagnostic(kChildFailureMessage);
    SetLastError(code);
    return FALSE;
  }
  return TRUE;
}

void attach_hooks(HMODULE module) {
  if (!capture_hook_path(module) || !capture_process_sids()) fail_closed();

  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr) fail_closed();
  g_real_add_access_allowed_ace = reinterpret_cast<RtlAddAccessAllowedAceFn>(
      GetProcAddress(ntdll, "RtlAddAccessAllowedAce"));
  g_real_set_information_token = reinterpret_cast<NtSetInformationTokenFn>(
      GetProcAddress(ntdll, "NtSetInformationToken"));
  if (g_real_add_access_allowed_ace == nullptr ||
      g_real_set_information_token == nullptr ||
      g_real_create_process_w == nullptr) {
    fail_closed();
  }

  if (DetourRestoreAfterWith() == FALSE ||
      DetourTransactionBegin() != NO_ERROR ||
      DetourUpdateThread(GetCurrentThread()) != NO_ERROR ||
      DetourAttach(
          reinterpret_cast<void**>(&g_real_add_access_allowed_ace),
          reinterpret_cast<void*>(&hooked_add_access_allowed_ace)) != NO_ERROR ||
      DetourAttach(
          reinterpret_cast<void**>(&g_real_set_information_token),
          reinterpret_cast<void*>(&hooked_set_information_token)) != NO_ERROR ||
      DetourAttach(
          reinterpret_cast<void**>(&g_real_create_process_w),
          reinterpret_cast<void*>(&hooked_create_process_w)) != NO_ERROR ||
      DetourTransactionCommit() != NO_ERROR) {
    fail_closed();
  }
  signal_guard_ready();
}

void detach_hooks() noexcept {
  if (g_real_add_access_allowed_ace == nullptr ||
      g_real_set_information_token == nullptr ||
      g_real_create_process_w == nullptr) {
    return;
  }
  if (DetourTransactionBegin() != NO_ERROR) return;
  if (DetourUpdateThread(GetCurrentThread()) != NO_ERROR) {
    DetourTransactionAbort();
    return;
  }
  DetourDetach(
      reinterpret_cast<void**>(&g_real_add_access_allowed_ace),
      reinterpret_cast<void*>(&hooked_add_access_allowed_ace));
  DetourDetach(
      reinterpret_cast<void**>(&g_real_set_information_token),
      reinterpret_cast<void*>(&hooked_set_information_token));
  DetourDetach(
      reinterpret_cast<void**>(&g_real_create_process_w),
      reinterpret_cast<void*>(&hooked_create_process_w));
  DetourTransactionCommit();
}

}  // namespace

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (DetourIsHelperProcess()) return TRUE;
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(instance);
    attach_hooks(instance);
  } else if (reason == DLL_PROCESS_DETACH) {
    detach_hooks();
  }
  return TRUE;
}
