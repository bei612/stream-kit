# Apply patches only inside the generated dependency sources. Git's discovery of
# an enclosing monorepo can silently skip all paths while returning success.
# GNU patch operates relative to the explicit working directory on both hosts.
function(APPLY_GIT_PATCH repo_path patch_path)
    find_program(SOURCE_PATCH_EXECUTABLE NAMES patch REQUIRED)
    set(patch_args -p1 --batch --fuzz=0 --ignore-whitespace -i "${patch_path}")
    execute_process(
            COMMAND "${SOURCE_PATCH_EXECUTABLE}" ${patch_args} --forward --dry-run
            WORKING_DIRECTORY "${repo_path}"
            RESULT_VARIABLE forward_status
            OUTPUT_VARIABLE patch_output ERROR_VARIABLE patch_error)
    if(forward_status EQUAL 0)
        execute_process(
                COMMAND "${SOURCE_PATCH_EXECUTABLE}" ${patch_args} --forward
                WORKING_DIRECTORY "${repo_path}"
                COMMAND_ERROR_IS_FATAL ANY)
        return()
    endif()

    # A repeated configure is allowed only when every hunk is already present.
    execute_process(
            COMMAND "${SOURCE_PATCH_EXECUTABLE}" ${patch_args} --force --reverse --dry-run
            WORKING_DIRECTORY "${repo_path}"
            RESULT_VARIABLE reverse_status
            OUTPUT_QUIET ERROR_QUIET)
    if(NOT reverse_status EQUAL 0)
        message(FATAL_ERROR "Dependency patch does not match its locked source: ${patch_path}\n"
                "${patch_output}${patch_error}")
    endif()
endfunction()
