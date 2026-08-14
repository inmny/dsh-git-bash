cmake_minimum_required(VERSION 3.25)
project(dsh_msys_token_guard LANGUAGES CXX)

set(DETOURS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/detours")
add_library(detours STATIC
  "${DETOURS_DIR}/detours.cpp"
  "${DETOURS_DIR}/modules.cpp"
  "${DETOURS_DIR}/disasm.cpp"
  "${DETOURS_DIR}/image.cpp"
  "${DETOURS_DIR}/creatwth.cpp"
)
target_include_directories(detours PUBLIC "${DETOURS_DIR}")
target_compile_definitions(detours PRIVATE WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00)
set_target_properties(detours PROPERTIES
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)

add_executable(msys-token-guard msys-token-guard.cpp)
add_library(msys-token-guard-hook SHARED msys-token-guard-hook.cpp)

foreach(target IN ITEMS msys-token-guard msys-token-guard-hook)
  target_compile_features(${target} PRIVATE cxx_std_20)
  target_compile_definitions(${target} PRIVATE UNICODE _UNICODE)
  target_link_libraries(${target} PRIVATE detours advapi32)
  set_target_properties(${target} PROPERTIES
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin/win32-x64"
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/bin/win32-x64"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin/win32-x64"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_CURRENT_SOURCE_DIR}/bin/win32-x64"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_CURRENT_SOURCE_DIR}/bin/win32-x64"
  )
endforeach()

if(MSVC)
  target_compile_options(detours PRIVATE
    /W4 /WX /GS /guard:cf /sdl /utf-8 /Zc:inline /Zc:preprocessor
  )
  foreach(target IN ITEMS msys-token-guard msys-token-guard-hook)
    target_compile_options(${target} PRIVATE
      /W4 /WX /permissive- /EHsc /GS /guard:cf /sdl /utf-8
      /Zc:__cplusplus /Zc:inline /Zc:preprocessor
    )
    target_link_options(${target} PRIVATE
      /DYNAMICBASE /NXCOMPAT /guard:cf /CETCOMPAT /OPT:REF /OPT:ICF /Brepro
    )
  endforeach()
  target_link_options(msys-token-guard PRIVATE
    "/MANIFESTUAC:level='asInvoker' uiAccess='false'"
  )
  target_link_options(msys-token-guard-hook PRIVATE
    "/EXPORT:DetourFinishHelperProcess,@1,NONAME"
  )
else()
  foreach(target IN ITEMS detours msys-token-guard msys-token-guard-hook)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endforeach()
endif()
