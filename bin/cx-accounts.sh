#!/usr/bin/env bash
# Host-side account metadata and mounts. Sourced by cx; no external CLI needed.
AGENT=""
ACCOUNT=""
ACCOUNT_AUTH=subscription
LEGACY_ACCOUNT=false
ACCOUNT_MOUNTS=()
ACCOUNT_ENV=()
readonly DATA_HOME="$(realpath -m -- "${CX_DATA_HOME:-$HOME/.local/share/cx/data}")"

valid_agent() { [[ "$1" == codex || "$1" == claude ]]; }
valid_account() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }

private_directory() {
    [[ ! -L "$1" ]] || die "Refusing a symlink in account storage: $1"
    mkdir -p -- "$1"
    chmod 700 -- "$1"
}

check_data_home() {
    [[ "$DATA_HOME" != / && "$DATA_HOME" != *,* ]] || die "Invalid CX_DATA_HOME."
    local native
    for native in "$HOME/.codex" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; do
        native="$(realpath -m -- "$native")"
        [[ "$DATA_HOME" != "$native" && "$DATA_HOME" != "$native/"* && "$native" != "$DATA_HOME/"* ]] || die "CX_DATA_HOME cannot overlap existing native CLI homes."
    done
}

account_options() {
    # Wrapper selection is recognized on either side of the workspace, but never
    # after --. Native --profile and its argument remain untouched.
    local parsing=true
    SELECTION_ARGS=()
    while (($#)); do
        if [[ "$parsing" == true ]]; then
            case "$1" in
                --) parsing=false ;;
                --agent|--account)
                    (($# > 1)) && [[ -n "$2" ]] || die "$1 requires a value."
                    if [[ "$1" == --agent ]]; then
                        [[ -z "$AGENT" ]] || die "--agent may only be supplied once."
                        AGENT="$2"
                    else
                        [[ -z "$ACCOUNT" ]] || die "--account may only be supplied once."
                        ACCOUNT="$2"
                    fi
                    shift 2; continue ;;
                --agent=*) [[ -z "$AGENT" ]] || die "Duplicate --agent."; AGENT="${1#*=}"; valid_agent "$AGENT" || die "Invalid --agent."; shift; continue ;;
                --account=*) [[ -z "$ACCOUNT" ]] || die "Duplicate --account."; ACCOUNT="${1#*=}"; valid_account "$ACCOUNT" || die "Invalid --account."; shift; continue ;;
                --config|--profile|--model|-m|--add-dir|--add-file|--ssh|--remote-dir|--enable|--disable|--settings|--mcp-config|--append-system-prompt|--system-prompt)
                    (($# > 1)) || die "$1 requires a value."
                    SELECTION_ARGS+=("$1" "$2"); shift 2; continue ;;
            esac
        fi
        SELECTION_ARGS+=("$1"); shift
    done
    [[ -z "$AGENT" ]] || valid_agent "$AGENT" || die "--agent accepts codex or claude."
    [[ -z "$ACCOUNT" ]] || valid_account "$ACCOUNT" || die "Invalid --account name."
}

accounts_command() {
    local action="${1:-list}" entry auth="" name cli temporary stored_auth
    (($# == 0)) || shift
    # --auth belongs only to account creation; selection parser handles the rest.
    local -a args=()
    while (($#)); do
        case "$1" in
            --auth) (($# > 1)) || die "--auth requires subscription or api-key."; auth="$2"; shift 2 ;;
            --auth=*) auth="${1#*=}"; shift ;;
            *) args+=("$1"); shift ;;
        esac
    done
    account_options "${args[@]}"
    ((${#SELECTION_ARGS[@]} == 0)) || die "Unexpected accounts argument."
    check_data_home
    case "$action" in
        list)
            [[ -z "$auth" ]] || die "--auth is only valid with accounts add."
            for cli in codex claude; do
                [[ -z "$AGENT" || "$AGENT" == "$cli" ]] || continue
                for entry in "$DATA_HOME/profiles/$cli/"*; do
                    [[ -f "$entry/auth-mode" && ! -L "$entry/auth-mode" && ! -L "$entry" ]] || continue
                    name="${entry##*/}"
                    valid_account "$name" || continue
                    stored_auth="$(<"$entry/auth-mode")"
                    [[ "$stored_auth" == subscription || "$stored_auth" == api-key ]] || continue
                    [[ -z "$ACCOUNT" || "$ACCOUNT" == "$name" ]] || continue
                    printf '%s\t%s\t%s\n' "$cli" "$name" "$stored_auth"
                done
            done ;;
        add|default)
            [[ -n "$AGENT" && -n "$ACCOUNT" ]] || die "accounts $action requires --agent and --account."
            entry="$DATA_HOME/profiles/$AGENT/$ACCOUNT"
            if [[ "$action" == add ]]; then
                [[ "$auth" == subscription || "$auth" == api-key ]] || die "accounts add requires --auth subscription|api-key."
                private_directory "$DATA_HOME"
                private_directory "$DATA_HOME/profiles"
                private_directory "$DATA_HOME/profiles/$AGENT"
                # mkdir is the exclusive creation step, including concurrent adds.
                (umask 077; mkdir -- "$entry") || die "Account already exists: $AGENT/$ACCOUNT"
                printf '%s\n' "$auth" >"$entry/auth-mode"
                printf 'Created %s/%s. Sign in with cx --agent %s --account %s --login.\n' "$AGENT" "$ACCOUNT" "$AGENT" "$ACCOUNT"
            else
                [[ -z "$auth" ]] || die "--auth is only valid with accounts add."
                [[ -f "$entry/auth-mode" && ! -L "$entry/auth-mode" && ! -L "$entry" ]] || die "Unknown account: $AGENT/$ACCOUNT"
                temporary="$(mktemp "$DATA_HOME/.default.XXXXXX")"
                printf '%s\n%s\n' "$AGENT" "$ACCOUNT" >"$temporary"
                mv -f -- "$temporary" "$DATA_HOME/automation-default"
            fi ;;
        *) die "Usage: cx accounts list|add|default [--agent codex|claude --account NAME] [--auth subscription|api-key]" ;;
    esac
}

select_account() {
    local entry cli name choice i=0
    local -a options=() defaults=()
    if [[ -n "${CX_CODEX_HOME:-}" ]]; then
        [[ -z "$ACCOUNT" && ( -z "$AGENT" || "$AGENT" == codex ) ]] || die "CX_CODEX_HOME legacy mode cannot be combined with managed accounts or Claude. Unset it first."
        AGENT=codex; ACCOUNT=legacy; LEGACY_ACCOUNT=true
        return
    fi
    check_data_home
    if [[ -z "$AGENT" || -z "$ACCOUNT" ]]; then
        if [[ -t 0 && -t 1 ]]; then
            for cli in codex claude; do
                [[ -z "$AGENT" || "$AGENT" == "$cli" ]] || continue
                for entry in "$DATA_HOME/profiles/$cli/"*; do
                    [[ -f "$entry/auth-mode" && ! -L "$entry/auth-mode" && ! -L "$entry" ]] || continue
                    name="${entry##*/}"
                    valid_account "$name" || continue
                    [[ -z "$ACCOUNT" || "$ACCOUNT" == "$name" ]] || continue
                    options+=("$cli/$name")
                    i=$((i + 1)); printf '%d) %s/%s\n' "$i" "$cli" "$name" >&2
                done
            done
            ((${#options[@]})) || die "No matching accounts. Use cx accounts add first."
            printf 'Choose CLI/account (q to cancel): ' >&2
            IFS= read -r choice || die "Account selection cancelled."
            [[ "$choice" =~ ^[0-9]{1,6}$ ]] || die "Account selection cancelled."
            i=$((10#$choice))
            ((i > 0 && i <= ${#options[@]})) || die "Invalid account selection."
            AGENT="${options[i-1]%%/*}"; ACCOUNT="${options[i-1]#*/}"
        else
            if [[ -f "$DATA_HOME/automation-default" ]]; then mapfile -t defaults <"$DATA_HOME/automation-default"; fi
            ((${#defaults[@]} == 2)) || die "Noninteractive use requires --agent and --account, or cx accounts default."
            [[ -z "$AGENT" || "$AGENT" == "${defaults[0]}" ]] && [[ -z "$ACCOUNT" || "$ACCOUNT" == "${defaults[1]}" ]] || die "Selection does not match the automation default; supply both --agent and --account."
            AGENT="${defaults[0]}"; ACCOUNT="${defaults[1]}"
        fi
    fi
    valid_agent "$AGENT" && valid_account "$ACCOUNT" || die "Invalid account selection."
    entry="$DATA_HOME/profiles/$AGENT/$ACCOUNT"
    [[ -f "$entry/auth-mode" && ! -L "$entry/auth-mode" && ! -L "$entry" ]] || die "Unknown account: $AGENT/$ACCOUNT"
    ACCOUNT_AUTH="$(<"$entry/auth-mode")"
    [[ "$ACCOUNT_AUTH" == subscription || "$ACCOUNT_AUTH" == api-key ]] || die "Invalid account metadata."
    HOST_CODEX_HOME="$entry/home"
}

history_link() {
    local path="$1" target="$2"
    if [[ -L "$path" ]]; then
        [[ "$(readlink -- "$path")" == "$target" ]] || die "Unexpected history link: $path"
    elif [[ -e "$path" ]]; then
        die "History path already exists; refusing to replace it: $path"
    else
        ln -s -- "$target" "$path"
    fi
}

prepare_account_mounts() {
    local shared item destination=/codex-home
    ACCOUNT_MOUNTS=(); ACCOUNT_ENV=(--env "CX_AGENT=$AGENT" --env "CX_ACCOUNT=$ACCOUNT" --env "CX_AUTH_MODE=$ACCOUNT_AUTH")
    if [[ "$LEGACY_ACCOUNT" == false ]]; then
        shared="$DATA_HOME/history/$AGENT"
        private_directory "$DATA_HOME/history"
        private_directory "$shared"
        private_directory "$HOST_CODEX_HOME"
        if [[ "$AGENT" == codex ]]; then
            for item in sessions archived_sessions thread-writer-locks sqlite; do private_directory "$shared/$item"; done
            for item in history.jsonl session_index.jsonl; do
                [[ -e "$shared/$item" ]] || (umask 077; touch -- "$shared/$item")
                [[ -f "$shared/$item" && ! -L "$shared/$item" ]] || die "Invalid history file: $item"
            done
            for item in sessions archived_sessions thread-writer-locks history.jsonl session_index.jsonl; do history_link "$HOST_CODEX_HOME/$item" "/cx-history/$item"; done
            ACCOUNT_ENV+=(--env CODEX_SQLITE_HOME=/cx-history/sqlite)
        else
            destination=/claude-home
            private_directory "$shared/projects"
            history_link "$HOST_CODEX_HOME/projects" /cx-history/projects
        fi
        ACCOUNT_MOUNTS+=(--mount "type=bind,src=${shared},dst=/cx-history")
    fi
    ACCOUNT_MOUNTS+=(--mount "type=bind,src=${HOST_CODEX_HOME},dst=$destination")
    ACCOUNT_ENV+=(--env CODEX_HOME=/codex-home --env CLAUDE_CONFIG_DIR=/claude-home --env DISABLE_AUTOUPDATER=1)
}

reject_private_overlap() {
    local requested="$1" kind="$2" secret
    local -a protected=("$DATA_HOME" "${CX_CODEX_HOME:-$HOME/.codex}" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$HOME/.claude.json")
    for secret in "${protected[@]}"; do
        secret="$(realpath -m -- "$secret")"
        if [[ "$requested" == "$secret" || "$requested" == "$secret/"* || ( "$kind" == directory && "$secret" == "$requested/"* ) ]]; then
            die "Refusing to expose private account or credential storage: $requested"
        fi
    done
}
