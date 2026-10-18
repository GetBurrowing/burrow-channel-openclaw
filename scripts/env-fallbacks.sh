# Burrow env-name fallback for the installer scripts (sourced, not executed).
#
# The product is now Burrow. Every env var these scripts read is spelled
# BURROW_<X> first, with the pre-rename SUITE_<X> spelling as a deprecated
# fallback, so an untouched host that exports only SUITE_* keeps working.
# Pure prefix swap, matching core's contract names.
#
# BURROW_ENV_FALLBACKS is the whole list, one "NEW:OLD" pair per entry.
# scripts/check-env-fallback.mjs pins it against a raw literal list: add a
# pair here and there together, never one without the other.
BURROW_ENV_FALLBACKS="BURROW_CHANNEL_EXT_DIR:SUITE_CHANNEL_EXT_DIR BURROW_CHANNEL_OC_CONFIG:SUITE_CHANNEL_OC_CONFIG BURROW_ACCOUNT_ID:SUITE_ACCOUNT_ID"

# burrow_env NEW_NAME
#
# Sets BURROW_ENV_VALUE to the value of NEW_NAME if it is set and non-empty,
# else to the value of its SUITE_ pair, else to "". When the SUITE_ value is
# used, writes ONE deprecation line per name per process tree to stderr.
# Call it directly, never inside $(...): a subshell would lose the warned-once
# flag and turn the exit below into a silent empty value.
# A NEW_NAME missing from BURROW_ENV_FALLBACKS is a programming error: it
# exits the calling script rather than silently ignoring the old spelling.
burrow_env() {
  local want="$1" pair new old flag
  BURROW_ENV_VALUE=""
  for pair in $BURROW_ENV_FALLBACKS; do
    new="${pair%%:*}"
    old="${pair#*:}"
    [ "$new" = "$want" ] || continue
    if [ -n "${!new:-}" ]; then
      BURROW_ENV_VALUE="${!new}"
    elif [ -n "${!old:-}" ]; then
      flag="__BURROW_WARNED_${old}"
      if [ -z "${!flag:-}" ]; then
        echo "[burrow-channel-openclaw] $old is deprecated; set $new" >&2
        export "$flag=1"
      fi
      BURROW_ENV_VALUE="${!old}"
    fi
    return 0
  done
  echo "[burrow-channel-openclaw] internal error: $want has no entry in BURROW_ENV_FALLBACKS" >&2
  exit 70
}
