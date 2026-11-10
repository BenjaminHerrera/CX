# Source from an interactive compute-node Bash startup file. The marker uses
# ordinary printable text so GNU screen can repaint it when attaching.
if [[ $- == *i* && ${SLURM_JOB_ID:-} =~ ^[0-9]+$ && -z ${__cx_interactive_hook_installed:-} ]]; then
    __cx_interactive_hook_installed=1
    __cx_interactive_ready() {
        local __cx_file __cx_token __cx_root
        local -a __cx_roots=()
        if [[ -n ${CX_INTERACTIVE_DIR:-} ]]; then
            __cx_roots+=("$CX_INTERACTIVE_DIR")
        else
            if [[ -r "$HOME/.config/cx/slurm-roots" ]]; then
                while IFS= read -r __cx_root || [[ -n $__cx_root ]]; do
                    [[ $__cx_root == /* ]] && __cx_roots+=("$__cx_root/interactive")
                done < "$HOME/.config/cx/slurm-roots"
            fi
        fi
        for __cx_root in "${__cx_roots[@]}"; do
            for __cx_file in "$__cx_root/"*; do
                [[ -f $__cx_file && ! -L $__cx_file ]] || continue
                __cx_token=${__cx_file##*/}
                [[ $__cx_token =~ ^[0-9a-f]{32}$ ]] || continue
                printf '\r\n__CX_READY_%s_%s__\n' "$__cx_token" "$SLURM_JOB_ID"
            done
        done
    }
    if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -a'; then
        PROMPT_COMMAND+=(__cx_interactive_ready)
    elif [[ -n ${PROMPT_COMMAND:-} ]]; then
        PROMPT_COMMAND="${PROMPT_COMMAND}; __cx_interactive_ready"
    else
        PROMPT_COMMAND=__cx_interactive_ready
    fi
fi
