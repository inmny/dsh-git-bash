#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <cwchar>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "detours.h"

namespace {

constexpr int kUsageExitCode = 64;
constexpr int kGuardFailureExitCode = 125;
constexpr wchar_t kReadyHandleEnvironment[] = L"DSH_MSYS_TOKEN_GUARD_READY_HANDLE";

class GuardFailure final : public std::runtime_error {
 public:
  GuardFailure(std::string operation, DWORD code)
      : std::runtime_error(std::move(operation)), code_(code) {}

  [[nodiscard]] DWORD code() const noexcept { return code_; }

 private:
  DWORD code_;
};

class UniqueHandle final {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  ~UniqueHandle() { reset(); }

  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;

  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  [[nodiscard]] HANDLE get() const noexcept { return value_; }
  [[nodiscard]] explicit operator bool() const noexcept {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }

  HANDLE release() noexcept {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }

  void reset(HANDLE value = nullptr) noexcept {
    if (*this) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

class LocalAllocation final {
 public:
  LocalAllocation() = default;
  explicit LocalAllocation(HLOCAL value) : value_(value) {}
  ~LocalAllocation() { reset(); }

  LocalAllocation(const LocalAllocation&) = delete;
  LocalAllocation& operator=(const LocalAllocation&) = delete;

  [[nodiscard]] HLOCAL get() const noexcept { return value_; }
  [[nodiscard]] explicit operator bool() const noexcept { return value_ != nullptr; }

  void reset(HLOCAL value = nullptr) noexcept {
    if (value_ != nullptr) LocalFree(value_);
    value_ = value;
  }

 private:
  HLOCAL value_ = nullptr;
};

[[noreturn]] void fail(const char* operation, DWORD code = GetLastError()) {
  throw GuardFailure(operation, code);
}

[[noreturn]] void fail_invariant(const char* detail) {
  throw GuardFailure(detail, ERROR_INVALID_SECURITY_DESCR);
}

std::vector<BYTE> token_information(HANDLE token, TOKEN_INFORMATION_CLASS info_class) {
  DWORD required = 0;
  if (GetTokenInformation(token, info_class, nullptr, 0, &required) != FALSE) {
    fail_invariant("GetTokenInformation unexpectedly accepted an empty buffer");
  }
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || required == 0) {
    fail("GetTokenInformation(size)");
  }

  std::vector<BYTE> buffer(required);
  if (GetTokenInformation(token, info_class, buffer.data(), required, &required) == FALSE) {
    fail("GetTokenInformation(data)");
  }
  return buffer;
}

UniqueHandle open_process_token(HANDLE process, DWORD access, const char* operation) {
  HANDLE token = nullptr;
  if (OpenProcessToken(process, access, &token) == FALSE) fail(operation);
  return UniqueHandle(token);
}

std::wstring sid_string(PSID sid) {
  if (sid == nullptr || IsValidSid(sid) == FALSE) fail_invariant("invalid SID in token data");
  LPWSTR raw = nullptr;
  if (ConvertSidToStringSidW(sid, &raw) == FALSE) fail("ConvertSidToStringSidW");
  LocalAllocation value(raw);
  return std::wstring(raw);
}

std::vector<std::wstring> restricted_sid_set(HANDLE token) {
  const auto buffer = token_information(token, TokenRestrictedSids);
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
  if (groups->GroupCount == 0) fail_invariant("token carries no restricting SIDs");

  std::vector<std::wstring> result;
  result.reserve(groups->GroupCount);
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    result.push_back(sid_string(groups->Groups[index].Sid));
  }
  std::sort(result.begin(), result.end());
  result.erase(std::unique(result.begin(), result.end()), result.end());
  if (result.size() != groups->GroupCount) fail_invariant("token carries duplicate restricting SIDs");
  return result;
}

bool default_dacl_allows_restricting_sid(HANDLE token) {
  const auto restricted_buffer = token_information(token, TokenRestrictedSids);
  const auto* restricted = reinterpret_cast<const TOKEN_GROUPS*>(restricted_buffer.data());
  const auto dacl_buffer = token_information(token, TokenDefaultDacl);
  const auto* info = reinterpret_cast<const TOKEN_DEFAULT_DACL*>(dacl_buffer.data());
  PACL dacl = info->DefaultDacl;
  if (dacl == nullptr || IsValidAcl(dacl) == FALSE) fail_invariant("token default DACL is missing or invalid");

  ACL_SIZE_INFORMATION size_info{};
  if (GetAclInformation(dacl, &size_info, sizeof(size_info), AclSizeInformation) == FALSE) {
    fail("GetAclInformation(TokenDefaultDacl)");
  }

  for (DWORD ace_index = 0; ace_index < size_info.AceCount; ++ace_index) {
    void* raw_ace = nullptr;
    if (GetAce(dacl, ace_index, &raw_ace) == FALSE) fail("GetAce(TokenDefaultDacl)");
    const auto* header = static_cast<const ACE_HEADER*>(raw_ace);
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;

    const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw_ace);
    const bool grants_full_access = (ace->Mask & GENERIC_ALL) != 0 ||
        (ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
    if (!grants_full_access) continue;
    PSID ace_sid = const_cast<DWORD*>(&ace->SidStart);
    if (IsValidSid(ace_sid) == FALSE) fail_invariant("invalid SID in token default DACL");

    for (DWORD sid_index = 0; sid_index < restricted->GroupCount; ++sid_index) {
      if (EqualSid(ace_sid, restricted->Groups[sid_index].Sid) != FALSE) return true;
    }
  }
  return false;
}

void verify_token_invariants(HANDLE token, const std::vector<std::wstring>* expected_sids = nullptr) {
  const auto sids = restricted_sid_set(token);
  if (expected_sids != nullptr && sids != *expected_sids) {
    fail_invariant("child restricting SID set differs from the guard token");
  }
  if (!default_dacl_allows_restricting_sid(token)) {
    fail_invariant("token default DACL has no full-access allow ACE for a restricting SID");
  }
}

void grant_logon_sid_to_default_dacl(HANDLE process) {
  UniqueHandle token = open_process_token(
      process,
      TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
      "OpenProcessToken(child default DACL)");
  auto groups_buffer = token_information(token.get(), TokenGroups);
  auto* groups = reinterpret_cast<TOKEN_GROUPS*>(groups_buffer.data());
  PSID logon_sid = nullptr;
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if ((groups->Groups[index].Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
      logon_sid = groups->Groups[index].Sid;
      break;
    }
  }
  if (logon_sid == nullptr || IsValidSid(logon_sid) == FALSE) {
    fail_invariant("child token carries no valid logon SID");
  }

  const auto restricted_buffer = token_information(token.get(), TokenRestrictedSids);
  const auto* restricted = reinterpret_cast<const TOKEN_GROUPS*>(restricted_buffer.data());
  bool logon_is_restricting = false;
  for (DWORD index = 0; index < restricted->GroupCount; ++index) {
    if (EqualSid(logon_sid, restricted->Groups[index].Sid) != FALSE) {
      logon_is_restricting = true;
      break;
    }
  }
  if (!logon_is_restricting) {
    fail_invariant("child logon SID is not a restricting SID");
  }

  const auto dacl_buffer = token_information(token.get(), TokenDefaultDacl);
  const auto* current_info = reinterpret_cast<const TOKEN_DEFAULT_DACL*>(dacl_buffer.data());
  if (current_info->DefaultDacl == nullptr || IsValidAcl(current_info->DefaultDacl) == FALSE) {
    fail_invariant("child token default DACL is missing or invalid");
  }

  EXPLICIT_ACCESSW grant{};
  grant.grfAccessPermissions = FILE_ALL_ACCESS;
  grant.grfAccessMode = GRANT_ACCESS;
  grant.grfInheritance = NO_INHERITANCE;
  grant.Trustee.pMultipleTrustee = nullptr;
  grant.Trustee.MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE;
  grant.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  grant.Trustee.TrusteeType = TRUSTEE_IS_GROUP;
  grant.Trustee.ptstrName = static_cast<LPWSTR>(logon_sid);

  PACL extended_dacl = nullptr;
  DWORD status = SetEntriesInAclW(1, &grant, current_info->DefaultDacl, &extended_dacl);
  if (status != ERROR_SUCCESS) fail("SetEntriesInAclW(logon default DACL)", status);
  LocalAllocation extended_owner(extended_dacl);

  TOKEN_DEFAULT_DACL updated{};
  updated.DefaultDacl = extended_dacl;
  if (SetTokenInformation(
          token.get(), TokenDefaultDacl, &updated, sizeof(updated)) == FALSE) {
    fail("SetTokenInformation(logon default DACL)");
  }
  verify_token_invariants(token.get());
}

bool adjust_default_is_denied(HANDLE process) {
  HANDLE probe = nullptr;
  if (OpenProcessToken(process, TOKEN_ADJUST_DEFAULT, &probe) != FALSE) {
    CloseHandle(probe);
    return false;
  }
  const DWORD code = GetLastError();
  if (code != ERROR_ACCESS_DENIED) fail("OpenProcessToken(TOKEN_ADJUST_DEFAULT probe)", code);
  return true;
}

void deny_adjust_default(HANDLE process, HANDLE query_token) {
  if (adjust_default_is_denied(process)) return;

  auto user_buffer = token_information(query_token, TokenUser);
  auto* user = reinterpret_cast<TOKEN_USER*>(user_buffer.data());
  if (user->User.Sid == nullptr || IsValidSid(user->User.Sid) == FALSE) {
    fail_invariant("child token user SID is invalid");
  }

  UniqueHandle writable = open_process_token(
      process,
      TOKEN_QUERY | READ_CONTROL | WRITE_DAC,
      "OpenProcessToken(child WRITE_DAC)");

  PACL current_dacl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  DWORD status = GetSecurityInfo(
      writable.get(),
      SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      &current_dacl,
      nullptr,
      &descriptor);
  if (status != ERROR_SUCCESS) fail("GetSecurityInfo(child token)", status);
  LocalAllocation descriptor_owner(descriptor);
  if (current_dacl == nullptr || IsValidAcl(current_dacl) == FALSE) {
    fail_invariant("child token object DACL is missing or invalid");
  }

  EXPLICIT_ACCESSW deny{};
  deny.grfAccessPermissions = TOKEN_ADJUST_DEFAULT;
  deny.grfAccessMode = DENY_ACCESS;
  deny.grfInheritance = NO_INHERITANCE;
  deny.Trustee.pMultipleTrustee = nullptr;
  deny.Trustee.MultipleTrusteeOperation = NO_MULTIPLE_TRUSTEE;
  deny.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  deny.Trustee.TrusteeType = TRUSTEE_IS_USER;
  deny.Trustee.ptstrName = static_cast<LPWSTR>(user->User.Sid);

  PACL hardened_dacl = nullptr;
  status = SetEntriesInAclW(1, &deny, current_dacl, &hardened_dacl);
  if (status != ERROR_SUCCESS) fail("SetEntriesInAclW(child token)", status);
  LocalAllocation hardened_owner(hardened_dacl);

  status = SetSecurityInfo(
      writable.get(),
      SE_KERNEL_OBJECT,
      DACL_SECURITY_INFORMATION,
      nullptr,
      nullptr,
      hardened_dacl,
      nullptr);
  if (status != ERROR_SUCCESS) fail("SetSecurityInfo(child token)", status);

  if (!adjust_default_is_denied(process)) {
    fail_invariant("child token still grants TOKEN_ADJUST_DEFAULT after hardening");
  }

  auto query_probe = open_process_token(process, TOKEN_QUERY, "OpenProcessToken(child TOKEN_QUERY probe)");
  verify_token_invariants(query_probe.get());
}

bool needs_quotes(const std::wstring& argument) {
  if (argument.empty()) return true;
  return argument.find_first_of(L" \t\n\v\"") != std::wstring::npos;
}

std::wstring quote_argument(const std::wstring& argument) {
  if (!needs_quotes(argument)) return argument;

  std::wstring quoted;
  quoted.push_back(L'"');
  size_t backslashes = 0;
  for (wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring command_line(int argc, wchar_t** argv, int first) {
  std::wstring result;
  for (int index = first; index < argc; ++index) {
    if (!result.empty()) result.push_back(L' ');
    result.append(quote_argument(argv[index]));
  }
  return result;
}

bool is_absolute_windows_path(const wchar_t* path) {
  if (path == nullptr || path[0] == L'\0') return false;
  if (path[0] == L'\\' && path[1] == L'\\') return true;
  const wchar_t drive = path[0];
  return ((drive >= L'A' && drive <= L'Z') || (drive >= L'a' && drive <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
}

void terminate_suspended_child(HANDLE process) noexcept {
  if (process == nullptr || process == INVALID_HANDLE_VALUE) return;
  TerminateProcess(process, kGuardFailureExitCode);
  WaitForSingleObject(process, 5'000);
}

void await_hook_ready(HANDLE ready_event, HANDLE process) {
  HANDLE handles[] = {ready_event, process};
  const DWORD wait = WaitForMultipleObjects(
      static_cast<DWORD>(std::size(handles)), handles, FALSE, 30'000);
  if (wait == WAIT_OBJECT_0) return;

  if (wait != WAIT_OBJECT_0 + 1) {
    TerminateProcess(process, kGuardFailureExitCode);
    WaitForSingleObject(process, 5'000);
  }
  const DWORD code = wait == WAIT_FAILED ? GetLastError() :
      wait == WAIT_TIMEOUT ? ERROR_TIMEOUT : ERROR_DLL_INIT_FAILED;
  fail("hook readiness handshake", code);
}

std::string hook_library_path() {
  std::vector<wchar_t> module_path(32768);
  const DWORD length = GetModuleFileNameW(
      nullptr, module_path.data(), static_cast<DWORD>(module_path.size()));
  if (length == 0 || length >= module_path.size() - 1) {
    fail("GetModuleFileNameW(guard)", length == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER);
  }
  std::wstring path(module_path.data(), length);
  const size_t separator = path.find_last_of(L"\\/");
  if (separator == std::wstring::npos) fail_invariant("guard executable has no parent directory");
  path.resize(separator + 1);
  path.append(L"msys-token-guard-hook.dll");

  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) fail("GetFileAttributesW(hook DLL)");
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    throw GuardFailure("hook DLL path is a directory", ERROR_DIRECTORY);
  }

  char ansi_path[MAX_PATH]{};
  BOOL used_default = FALSE;
  const int converted = WideCharToMultiByte(
      CP_ACP,
      WC_NO_BEST_FIT_CHARS,
      path.c_str(),
      -1,
      ansi_path,
      static_cast<int>(std::size(ansi_path)),
      nullptr,
      &used_default);
  if (converted <= 0 || used_default != FALSE) {
    fail("WideCharToMultiByte(hook DLL)", converted <= 0 ? GetLastError() : ERROR_NO_UNICODE_TRANSLATION);
  }
  return std::string(ansi_path);
}

DWORD launch_guarded(int argc, wchar_t** argv) {
  if (argc == 2 && std::wcscmp(argv[1], L"--probe-current-token") == 0) {
    auto token = open_process_token(GetCurrentProcess(), TOKEN_QUERY, "OpenProcessToken(probe)");
    verify_token_invariants(token.get());
    if (!adjust_default_is_denied(GetCurrentProcess())) {
      fail_invariant("current token still grants TOKEN_ADJUST_DEFAULT");
    }
    std::fprintf(stdout, "token-adjust-default=denied\n");
    return ERROR_SUCCESS;
  }
  if (argc < 3 || std::wcscmp(argv[1], L"--") != 0) {
    std::fprintf(stderr, "usage: msys-token-guard.exe -- <absolute-program> [arguments...]\n");
    return kUsageExitCode;
  }
  if (!is_absolute_windows_path(argv[2])) {
    throw GuardFailure("target program path must be absolute", ERROR_INVALID_NAME);
  }
  const DWORD target_attributes = GetFileAttributesW(argv[2]);
  if (target_attributes == INVALID_FILE_ATTRIBUTES) fail("GetFileAttributesW(target)");
  if ((target_attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    throw GuardFailure("target program is a directory", ERROR_DIRECTORY);
  }

  auto guard_token = open_process_token(GetCurrentProcess(), TOKEN_QUERY, "OpenProcessToken(guard)");
  const auto expected_sids = restricted_sid_set(guard_token.get());
  verify_token_invariants(guard_token.get(), &expected_sids);
  const std::string hook_path = hook_library_path();

  std::wstring line = command_line(argc, argv, 2);
  std::vector<wchar_t> mutable_line(line.begin(), line.end());
  mutable_line.push_back(L'\0');

  if (SetEnvironmentVariableW(L"CYGWIN_TESTING", L"1") == FALSE) {
    fail("SetEnvironmentVariableW(CYGWIN_TESTING)");
  }

  SECURITY_ATTRIBUTES event_security{};
  event_security.nLength = sizeof(event_security);
  event_security.bInheritHandle = TRUE;
  UniqueHandle hook_ready(CreateEventW(&event_security, FALSE, FALSE, nullptr));
  if (!hook_ready) fail("CreateEventW(hook readiness)");

  wchar_t ready_handle[32]{};
  const int ready_length = std::swprintf(
      ready_handle,
      std::size(ready_handle),
      L"%llx",
      static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(hook_ready.get())));
  if (ready_length <= 0 || static_cast<size_t>(ready_length) >= std::size(ready_handle)) {
    fail_invariant("failed to serialize hook readiness handle");
  }
  if (SetEnvironmentVariableW(kReadyHandleEnvironment, ready_handle) == FALSE) {
    fail("SetEnvironmentVariableW(hook readiness)");
  }

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

  PROCESS_INFORMATION process_info{};
  const BOOL created = DetourCreateProcessWithDllExW(
      argv[2],
      mutable_line.data(),
      nullptr,
      nullptr,
      TRUE,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
      nullptr,
      nullptr,
      &startup,
      &process_info,
      hook_path.c_str(),
      CreateProcessW);
  const DWORD create_error = created == FALSE ? GetLastError() : ERROR_SUCCESS;
  if (SetEnvironmentVariableW(kReadyHandleEnvironment, nullptr) == FALSE) {
    if (created != FALSE) terminate_suspended_child(process_info.hProcess);
    fail("SetEnvironmentVariableW(clear hook readiness)");
  }
  if (created == FALSE) {
    fail("DetourCreateProcessWithDllExW(target, suspended)", create_error);
  }

  UniqueHandle child_process(process_info.hProcess);
  UniqueHandle child_thread(process_info.hThread);
  bool resumed = false;
  try {
    auto child_token = open_process_token(
        child_process.get(), TOKEN_QUERY, "OpenProcessToken(child TOKEN_QUERY)");
    verify_token_invariants(child_token.get(), &expected_sids);
    grant_logon_sid_to_default_dacl(child_process.get());
    deny_adjust_default(child_process.get(), child_token.get());

    const DWORD previous_suspend_count = ResumeThread(child_thread.get());
    if (previous_suspend_count == static_cast<DWORD>(-1)) fail("ResumeThread(target)");
    if (previous_suspend_count != 1) fail_invariant("target primary thread had an unexpected suspend count");
    resumed = true;
    child_thread.reset();
    await_hook_ready(hook_ready.get(), child_process.get());
    hook_ready.reset();

    const DWORD wait = WaitForSingleObject(child_process.get(), INFINITE);
    if (wait != WAIT_OBJECT_0) {
      const DWORD code = wait == WAIT_FAILED ? GetLastError() : ERROR_GEN_FAILURE;
      TerminateProcess(child_process.get(), kGuardFailureExitCode);
      WaitForSingleObject(child_process.get(), 5'000);
      fail("WaitForSingleObject(target)", code);
    }

    DWORD exit_code = 0;
    if (GetExitCodeProcess(child_process.get(), &exit_code) == FALSE) {
      fail("GetExitCodeProcess(target)");
    }
    if (exit_code == STILL_ACTIVE) fail_invariant("target remained active after signaling completion");
    return exit_code;
  } catch (...) {
    if (!resumed) terminate_suspended_child(child_process.get());
    throw;
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
  try {
    return static_cast<int>(launch_guarded(argc, argv));
  } catch (const GuardFailure& error) {
    std::fprintf(
        stderr,
        "msys-token-guard: %s failed (Win32 %lu)\n",
        error.what(),
        static_cast<unsigned long>(error.code()));
    return kGuardFailureExitCode;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "msys-token-guard: unexpected failure: %s\n", error.what());
    return kGuardFailureExitCode;
  }
}
