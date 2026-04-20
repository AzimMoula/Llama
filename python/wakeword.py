import os
import sys
import time
import re
import io
import json
import wave
import base64
import urllib.request
import urllib.error
import signal
import subprocess
from glob import glob
from pathlib import Path
from typing import Dict, List, cast
import numpy as np

try:
    from openwakeword.model import Model
except Exception as e:
    print(f"[WakeWord] Failed to import openwakeword: {e}", file=sys.stderr)
    sys.exit(1)


def parse_list(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def normalize_wake_word_name(value: str) -> str:
    # openWakeWord model names use lowercase with underscores.
    return "_".join(value.strip().lower().split())


DEFAULT_MODEL_FALLBACKS = ["hey_jarvis", "alexa", "hey_mycroft", "hey_rhasspy"]
WAKE_WORD_MODEL_ALIASES = {
    "lama": "hey_jarvis",
    "hey_lama": "hey_jarvis",
    "ok_lama": "hey_jarvis",
    "okay_lama": "hey_jarvis",
    "sora": "hey_jarvis",
    "hey_sora": "hey_jarvis",
    "ok_sora": "hey_jarvis",
    "okay_sora": "hey_jarvis",
}


def resolve_model_names(wake_words: List[str]) -> List[str]:
    resolved: List[str] = []
    for wake_word in wake_words:
        resolved.append(WAKE_WORD_MODEL_ALIASES.get(wake_word, wake_word))
    # Keep order stable while removing duplicates.
    return list(dict.fromkeys(resolved))


def canonical_model_id(model_path: str) -> str:
    stem = Path(model_path).stem.lower()
    # Strip version suffixes like _v0.1 or _v1.
    return re.sub(r"_v\d+(?:\.\d+)*$", "", stem)


def normalize_text_for_match(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split())


def expand_phrase_variants(phrase: str) -> List[str]:
    variants = {normalize_text_for_match(phrase)}
    if "lama" in phrase:
        variants.add(normalize_text_for_match(phrase.replace("lama", "llama")))
    if "llama" in phrase:
        variants.add(normalize_text_for_match(phrase.replace("llama", "lama")))
    if "sora" in phrase:
        variants.add(normalize_text_for_match(phrase.replace("sora", "so ra")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "sorah")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "soraa")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "soora")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "soura")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "saura")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "sura")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "surah")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "sara")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "sarah")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "zara")))
        variants.add(normalize_text_for_match(phrase.replace("sora", "zora")))
    return [item for item in variants if item]


def build_wake_tokens(wake_phrases: List[str]) -> List[str]:
    tokens: List[str] = []
    for phrase in wake_phrases:
        for token in phrase.split():
            if len(token) >= 3 and token not in tokens:
                tokens.append(token)
    return tokens


def parse_wake_extra_phrases(value: str) -> List[str]:
    # Supports comma or newline separated phrase lists from env.
    if not value:
        return []
    raw_parts = re.split(r"[,\n]", value)
    return [normalize_text_for_match(item) for item in raw_parts if item.strip()]


def truncate_for_log(value: str, max_len: int = 160) -> str:
    text = value.strip()
    if len(text) <= max_len:
        return text
    return f"{text[:max_len]}..."


def levenshtein_distance_limit(a: str, b: str, limit: int = 1) -> int:
    if a == b:
        return 0
    if abs(len(a) - len(b)) > limit:
        return limit + 1

    previous = list(range(len(b) + 1))
    for i, char_a in enumerate(a, start=1):
        current = [i]
        min_in_row = current[0]
        for j, char_b in enumerate(b, start=1):
            cost = 0 if char_a == char_b else 1
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost,
                )
            )
            min_in_row = min(min_in_row, current[j])
        if min_in_row > limit:
            return limit + 1
        previous = current
    return previous[-1]


def normalize_wake_token(token: str) -> str:
    # Fold common ASR accent drift for wake phrases.
    token = token.lower()
    if token in {"ok", "okay", "okey", "oke", "okeyy", "okayy", "k", "kay"}:
        return "ok"
    if token in {"hey", "he", "hay", "hi", "hai", "ay", "ei"}:
        return "hey"

    # Many ASR outputs vary around lama/llama/lamma; fold to a single target.
    if re.fullmatch(r"l+a+m+a+", token) or re.fullmatch(r"l+a+m+m+a+", token):
        return "llama"
    if token in {
        "lama",
        "llama",
        "lamma",
        "llamma",
        "lamaa",
        "llamaa",
        "lamah",
        "llamah",
    }:
        return "llama"

    # Fold common ASR variants of "sora" across accents.
    cleaned = re.sub(r"[^a-z]", "", token)

    if token in {
        "sora",
        "sorah",
        "sorra",
        "sorrah",
        "sohra",
        "soora",
        "soorah",
        "soura",
        "saura",
        "sawra",
        "sawrah",
        "sorae",
        "sorahh",
        "suraa",
        "sura",
        "surah",
        "shora",
        "shorah",
        "shoura",
        "shura",
        "shurah",
        "zora",
        "zorah",
        "zorra",
        "zoura",
        "zaura",
        "zura",
        "zurah",
        "soraa",
        "sara",
        "sarah",
        "zara",
        "zarah",
        "sera",
        "seraah",
        "saira",
    }:
        return "sora"

    if re.fullmatch(r"s+o+r+a+", cleaned) or re.fullmatch(r"z+o+r+a+", cleaned):
        return "sora"

    # Broader phonetic catch for accented ASR outputs: sora/sura/saura/zora/shora families.
    if re.fullmatch(r"(?:s|z|sh)+(?:o|oo|ou|au|u|a)+r+r?a+h*", cleaned):
        return "sora"
    if re.fullmatch(r"(?:s|z|sh)+(?:o|oo|ou|au|u|a)+r+h*", cleaned):
        return "sora"

    return token


def tokenize_normalized_text(value: str) -> List[str]:
    if not value:
        return []
    return [normalize_wake_token(t) for t in value.split() if t]


def token_matches_target(token: str, target: str, distance_limit: int) -> bool:
    token = normalize_wake_token(token)
    target = normalize_wake_token(target)
    if token == target:
        return True
    return levenshtein_distance_limit(token, target, limit=distance_limit) <= distance_limit


def format_prediction_snapshot(prediction: Dict[str, float], limit: int = 3) -> str:
    if not prediction:
        return "<empty>"

    items = sorted(prediction.items(), key=lambda item: float(item[1]), reverse=True)[:limit]
    return ", ".join(f"{keyword}:{float(score):.3f}" for keyword, score in items)


def is_wake_match(
    normalized_text: str,
    wake_phrases: List[str],
    wake_tokens: List[str],
    token_distance_limit: int = 1,
) -> tuple[bool, str]:
    canonical_text = " ".join(tokenize_normalized_text(normalized_text))
    text_tokens = tokenize_normalized_text(normalized_text)
    if not text_tokens:
        return False, "no_tokens"

    require_hey = os.getenv("WAKE_WORD_ASR_STRICT_REQUIRE_HEY", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    strict_require_prefix = os.getenv("WAKE_WORD_ASR_STRICT_REQUIRE_PREFIX", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    prefix_tokens_env = os.getenv("WAKE_WORD_ASR_PREFIX_TOKENS", "ok,okay,hey,hi")
    prefix_tokens = [
        normalize_wake_token(item)
        for item in parse_list(prefix_tokens_env)
        if item.strip()
    ]
    if not prefix_tokens:
        prefix_tokens = ["ok", "hey"]
    allow_single_target = os.getenv("WAKE_WORD_ASR_ALLOW_SINGLE_TARGET", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }

    target_tokens_env = os.getenv("WAKE_WORD_ASR_TARGET_TOKENS", "")
    target_tokens: List[str] = []
    if target_tokens_env.strip():
        target_tokens = [
            normalize_wake_token(item)
            for item in parse_list(target_tokens_env)
            if item.strip()
        ]
    if not target_tokens:
        target_tokens = [
            token
            for token in wake_tokens
            if token not in {"ok", "okay", "hey", "hi"}
        ]
    if not target_tokens:
        target_tokens = wake_tokens[:]

    target_tokens = list(dict.fromkeys([token for token in target_tokens if token]))

    for phrase in wake_phrases:
        canonical_phrase = " ".join(tokenize_normalized_text(phrase))
        if canonical_phrase and canonical_phrase in canonical_text:
            phrase_tokens = canonical_phrase.split()
            phrase_has_target = any(token in target_tokens for token in phrase_tokens)
            phrase_has_prefix = any(token in prefix_tokens for token in phrase_tokens)
            phrase_has_hey = "hey" in phrase_tokens
            if require_hey:
                if phrase_has_target and phrase_has_hey:
                    return True, f"phrase:{canonical_phrase}"
            elif phrase_has_target and (not strict_require_prefix or phrase_has_prefix):
                return True, f"phrase:{canonical_phrase}"

    # Handle fused outputs like "heysora" / "oksora" without a token boundary.
    joined = "".join(text_tokens)
    has_prefix_in_joined = any(prefix in joined for prefix in prefix_tokens)
    has_target_in_joined = any(target in joined for target in target_tokens)
    if has_target_in_joined:
        if require_hey:
            if "hey" in joined:
                return True, "fused:hey+target"
        elif not strict_require_prefix or has_prefix_in_joined:
            return True, "fused:prefix+target"

    has_hey = any(token_matches_target(token, "hey", 1) for token in text_tokens)
    has_prefix = any(
        token_matches_target(token, prefix, 1)
        for token in text_tokens
        for prefix in prefix_tokens
    )
    has_target = any(
        token_matches_target(token, target, token_distance_limit)
        for token in text_tokens
        for target in target_tokens
    )

    if require_hey:
        if has_hey and has_target:
            return True, "tokens:hey+target"
        return False, "strict_need_hey"

    if strict_require_prefix:
        if has_prefix and has_target:
            return True, "tokens:prefix+target"
        return False, "strict_need_prefix"

    if has_target and (allow_single_target or has_hey):
        return True, "tokens:target"

    # Keep wake token usage only as a secondary fallback and still require target-token hit.
    fuzzy_wake_hits = 0
    for token in text_tokens:
        for wake_token in wake_tokens:
            if token_matches_target(token, wake_token, token_distance_limit):
                fuzzy_wake_hits += 1
    if has_target and fuzzy_wake_hits >= 1:
        return True, f"fuzzy_hits:{fuzzy_wake_hits}"

    return False, "no_target_token"


def pcm16_to_wav_base64(pcm_bytes: bytes, sample_rate: int = 16000) -> str:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_bytes)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def recognize_text_with_asr(
    pcm_bytes: bytes,
    endpoint: str,
    language: str,
    timeout_sec: float,
    retries: int = 0,
    timeout_multiplier: float = 1.5,
    log_requests: bool = True,
) -> str:
    payload = {"base64": pcm16_to_wav_base64(pcm_bytes)}
    if language:
        payload["language"] = language

    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    attempt = 0
    last_error: Exception | None = None
    while attempt <= max(0, retries):
        try:
            effective_timeout = timeout_sec * (timeout_multiplier**attempt)
            if log_requests:
                print(
                    "[WakeWord] ASR call "
                    f"attempt={attempt + 1}/{max(0, retries) + 1} endpoint={endpoint} timeout={effective_timeout:.1f}s"
                )
            with urllib.request.urlopen(request, timeout=effective_timeout) as response:
                body = response.read().decode("utf-8", errors="ignore")
                data = json.loads(body)
            return str(data.get("recognition", "")).strip()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            # Only retry on timeout-like errors to avoid masking real request failures.
            message = str(error).lower()
            is_timeout = isinstance(error, TimeoutError) or "timed out" in message
            if not is_timeout or attempt >= retries:
                raise
            attempt += 1

    if last_error is not None:
        raise last_error
    return ""


def build_sox_capture_cmd() -> List[str]:
    capture_device = os.getenv("WAKE_WORD_AUDIO_DEVICE") or os.getenv("AUDIODEV") or "default"
    gain_db = os.getenv("WAKE_WORD_ASR_GAIN_DB", "0").strip()
    capture_channel = (os.getenv("WAKE_WORD_AUDIO_CHANNEL") or os.getenv("AUDIO_INPUT_CHANNEL") or "1").strip()
    highpass_hz = max(0, int(os.getenv("WAKE_WORD_AUDIO_HIGHPASS_HZ", os.getenv("AUDIO_INPUT_HIGHPASS_HZ", "120"))))
    lowpass_hz = max(0, int(os.getenv("WAKE_WORD_AUDIO_LOWPASS_HZ", os.getenv("AUDIO_INPUT_LOWPASS_HZ", "4200"))))
    cmd = [
        "sox",
        "-t",
        "alsa",
        capture_device,
        "-r",
        "16000",
        "-b",
        "16",
        "-e",
        "signed-integer",
        "-c",
        "1",
        "-t",
        "raw",
        "-",
        "remix",
        capture_channel,
        "highpass",
        str(highpass_hz),
        "lowpass",
        str(lowpass_hz),
    ]
    # Optional software gain helps low-input capture devices without changing system mixer.
    if gain_db and gain_db not in {"0", "0.0"}:
        cmd.extend(["gain", gain_db])
    return cmd


def run_asr_wake_loop(wake_words: List[str], cooldown_sec: float) -> None:
    asr_enabled = os.getenv("WAKE_WORD_ASR_FALLBACK", "true").strip().lower() in {"1", "true", "yes", "on"}
    if not asr_enabled:
        print("[WakeWord] ASR fallback disabled. Entering passive mode.", file=sys.stderr)
        passive_wait_loop()
        return

    endpoint = os.getenv("WAKE_WORD_ASR_ENDPOINT", "http://faster-whisper:8803/recognize")
    language = os.getenv("WAKE_WORD_ASR_LANGUAGE", "")
    timeout_sec = float(os.getenv("WAKE_WORD_ASR_TIMEOUT_SEC", "12.0"))
    chunk_sec = float(os.getenv("WAKE_WORD_ASR_CHUNK_SEC", "1.8"))
    min_interval_sec = float(os.getenv("WAKE_WORD_ASR_MIN_INTERVAL_SEC", "1.2"))
    min_rms = float(os.getenv("WAKE_WORD_ASR_MIN_RMS", "300"))
    min_peak = float(os.getenv("WAKE_WORD_ASR_MIN_PEAK", "2200"))
    min_voiced_amp = float(os.getenv("WAKE_WORD_ASR_MIN_VOICED_AMP", "700"))
    min_voiced_ratio = float(os.getenv("WAKE_WORD_ASR_MIN_VOICED_RATIO", "0.08"))
    timeout_backoff_sec = float(os.getenv("WAKE_WORD_ASR_TIMEOUT_BACKOFF_SEC", "4.0"))
    max_backoff_sec = float(os.getenv("WAKE_WORD_ASR_MAX_BACKOFF_SEC", "15.0"))
    error_backoff_sec = float(os.getenv("WAKE_WORD_ASR_ERROR_BACKOFF_SEC", "8.0"))
    max_error_backoff_sec = float(os.getenv("WAKE_WORD_ASR_MAX_ERROR_BACKOFF_SEC", "60.0"))
    retry_count = int(os.getenv("WAKE_WORD_ASR_RETRIES", "1"))
    retry_timeout_multiplier = float(os.getenv("WAKE_WORD_ASR_RETRY_TIMEOUT_MULTIPLIER", "1.5"))
    bypass_gating = os.getenv("WAKE_WORD_ASR_BYPASS_GATING", "false").strip().lower() in {"1", "true", "yes", "on"}
    debug_enabled = os.getenv("WAKE_WORD_ASR_DEBUG", "true").strip().lower() in {"1", "true", "yes", "on"}
    debug_log_interval_sec = float(os.getenv("WAKE_WORD_ASR_DEBUG_LOG_INTERVAL_SEC", "5.0"))
    token_distance_limit = int(os.getenv("WAKE_WORD_ASR_TOKEN_DISTANCE_LIMIT", "2"))
    match_window_sec = float(os.getenv("WAKE_WORD_ASR_MATCH_WINDOW_SEC", "4.0"))
    extra_phrases_raw = os.getenv("WAKE_WORD_ASR_EXTRA_PHRASES", "")
    trace_transcripts = os.getenv("WAKE_WORD_ASR_TRACE_TRANSCRIPTS", "true").strip().lower() in {"1", "true", "yes", "on"}
    log_all_transcripts = os.getenv("WAKE_WORD_ASR_LOG_ALL_TRANSCRIPTS", "true").strip().lower() in {"1", "true", "yes", "on"}
    compact_idle_log = os.getenv("WAKE_WORD_ASR_COMPACT_IDLE_LOG", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    chunk_bytes = max(640, int(16000 * 2 * chunk_sec))

    wake_phrases: List[str] = []
    for word in wake_words:
        wake_phrases.extend(expand_phrase_variants(word.replace("_", " ")))
    # Add broad pronunciation variants for "sora" across accents/ASR drift.
    wake_phrases.extend(
        [
            "sora",
            "so ra",
            "sorah",
            "soraa",
            "soora",
            "soorah",
            "sorra",
            "sorrah",
            "soura",
            "sura",
            "surah",
            "saura",
            "sawra",
            "shora",
            "zora",
            "zorra",
            "zoura",
            "zura",
            "zara",
            "zarah",
            "sara",
            "sarah",
            "ok sora",
            "ok soora",
            "ok surah",
            "ok zara",
            "okay sora",
            "okay soora",
            "okay zora",
            "okay surah",
            "okay zara",
            "hey sora",
            "hey soora",
            "hey zora",
            "hey surah",
            "hey zara",
            "hi sora",
            "hi soora",
            "hi zora",
            "hi surah",
            "hi zara",
            "hay sora",
            "he sora",
            "oksora",
            "heysora",
            "okzora",
            "heyzora",
            "oksoora",
            "heysoora",
        ]
    )
    wake_phrases.extend(parse_wake_extra_phrases(extra_phrases_raw))
    wake_phrases = list(dict.fromkeys([phrase for phrase in wake_phrases if phrase]))
    wake_tokens = [normalize_wake_token(token) for token in build_wake_tokens(wake_phrases)]
    wake_tokens = list(dict.fromkeys([token for token in wake_tokens if token]))

    if not wake_phrases:
        print("[WakeWord] No wake phrases available for ASR fallback. Entering passive mode.", file=sys.stderr)
        passive_wait_loop()
        return

    sox_cmd = build_sox_capture_cmd()
    print(f"[WakeWord] Capture command: {' '.join(sox_cmd)}")
    print(
        "[WakeWord] WAITING FOR WAKE WORD "
        f"(listen={chunk_sec:.1f}s chunks, min_interval={min_interval_sec:.1f}s, "
        f"timeout={timeout_sec:.1f}s, backoff={timeout_backoff_sec:.1f}s)"
    )

    process = subprocess.Popen(
        sox_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    def cleanup(*_) -> None:
        try:
            process.terminate()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    last_trigger = 0.0
    last_request = 0.0
    last_error_log = 0.0
    last_debug_log = 0.0
    timeout_backoff_until = 0.0
    consecutive_timeouts = 0
    consecutive_errors = 0
    sent_requests = 0
    skipped_low_energy = 0
    skipped_low_peak = 0
    skipped_low_voiced = 0
    skipped_cooldown = 0
    skipped_interval = 0
    skipped_backoff = 0
    recent_transcripts: List[tuple[float, str]] = []
    print("[WakeWord] READY (ASR fallback mode)", flush=True)
    if bypass_gating:
        print("[WakeWord] ASR gating bypass enabled for diagnostics.", flush=True)

    while True:
        if process.stdout is None:
            time.sleep(0.1)
            continue

        data = process.stdout.read(chunk_bytes)
        if not data or len(data) < chunk_bytes:
            time.sleep(0.01)
            continue

        now = time.time()
        if now - last_trigger < cooldown_sec:
            skipped_cooldown += 1
            continue
        if now - last_request < min_interval_sec:
            skipped_interval += 1
            continue
        if now < timeout_backoff_until:
            skipped_backoff += 1
            if debug_enabled and skipped_backoff % 10 == 1:
                print(
                    "[WakeWord] ASR backoff active "
                    f"for {max(0.0, timeout_backoff_until - now):.1f}s"
                )
            continue

        # Skip ASR calls for low-energy chunks (ambient noise/silence).
        audio = np.frombuffer(data, dtype=np.int16)
        if audio.size == 0:
            continue
        abs_audio = np.abs(audio)
        mean_abs = float(np.mean(abs_audio))
        peak_abs = float(np.max(abs_audio))
        voiced_ratio = float(np.mean(abs_audio >= min_voiced_amp))

        if debug_enabled and now - last_debug_log >= debug_log_interval_sec:
            print(
                "[WakeWord] ASR monitor "
                f"mean={mean_abs:.1f} peak={peak_abs:.1f} voiced={voiced_ratio:.3f} "
                f"thresholds(rms>={min_rms},peak>={min_peak},voiced>={min_voiced_ratio}) "
                f"stats(sent={sent_requests},skip_rms={skipped_low_energy},skip_peak={skipped_low_peak},"
                f"skip_voiced={skipped_low_voiced},skip_cd={skipped_cooldown},skip_itv={skipped_interval},skip_bk={skipped_backoff})"
            )
            last_debug_log = now

        if not bypass_gating:
            if mean_abs < min_rms:
                skipped_low_energy += 1
                continue
            if peak_abs < min_peak:
                skipped_low_peak += 1
                continue
            if voiced_ratio < min_voiced_ratio:
                skipped_low_voiced += 1
                continue

        last_request = now
        sent_requests += 1
        if debug_enabled:
            print(
                "[WakeWord] ASR request -> /recognize "
                f"(sent={sent_requests}, gate=passed, rms={mean_abs:.1f}, peak={peak_abs:.1f}, voiced={voiced_ratio:.3f})"
            )

        try:
            text = recognize_text_with_asr(
                data,
                endpoint=endpoint,
                language=language,
                timeout_sec=timeout_sec,
                retries=retry_count,
                timeout_multiplier=retry_timeout_multiplier,
                log_requests=debug_enabled,
            )
            consecutive_timeouts = 0
            consecutive_errors = 0
            timeout_backoff_until = 0.0
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError) as e:
            error_message = str(e).lower()
            is_timeout = isinstance(e, TimeoutError) or "timed out" in error_message
            is_connection_issue = (
                "connection refused" in error_message
                or "[errno 111]" in error_message
                or "temporary failure in name resolution" in error_message
                or "name or service not known" in error_message
                or "failed to establish a new connection" in error_message
            )

            if is_timeout:
                consecutive_timeouts += 1
                backoff = min(max_backoff_sec, timeout_backoff_sec * max(1, consecutive_timeouts))
                timeout_backoff_until = time.time() + backoff
            else:
                consecutive_timeouts = 0

            if is_connection_issue or isinstance(e, urllib.error.URLError):
                consecutive_errors += 1
                error_backoff = min(
                    max_error_backoff_sec,
                    error_backoff_sec * max(1, consecutive_errors),
                )
                timeout_backoff_until = max(timeout_backoff_until, time.time() + error_backoff)
            if now - last_error_log > 10.0:
                retry_in = max(0.0, timeout_backoff_until - time.time())
                print(
                    f"[WakeWord] ASR fallback error: {e} (retry in {retry_in:.1f}s)",
                    file=sys.stderr,
                )
                last_error_log = now
            continue

        if not text:
            if debug_enabled:
                print("[WakeWord] ASR heard: <empty>")
            if log_all_transcripts:
                print("[WakeWord] LISTEN transcript_raw=<empty> transcript_norm=<empty>")
            if compact_idle_log:
                print(
                    "[WakeWord][IDLE] "
                    'heard_raw="<empty>" heard_norm="<empty>" match=False reason=empty_transcript'
                )
            continue

        if log_all_transcripts:
            print(
                "[WakeWord] LISTEN "
                f'transcript_raw="{truncate_for_log(text)}"'
            )

        normalized_text = normalize_text_for_match(text)
        print(f"[WakeWord] ASR heard: {normalized_text}")
        if log_all_transcripts:
            print(
                "[WakeWord] LISTEN "
                f'transcript_norm="{truncate_for_log(normalized_text)}"'
            )

        # Keep a short rolling transcript window to catch split wake phrases
        # across adjacent ASR chunks (common with accented speech timing).
        current_ts = time.time()
        recent_transcripts.append((current_ts, normalized_text))
        recent_transcripts = [
            item for item in recent_transcripts if current_ts - item[0] <= match_window_sec
        ]
        combined_text = " ".join([item[1] for item in recent_transcripts]).strip()

        matched, match_reason = is_wake_match(
            combined_text or normalized_text,
            wake_phrases,
            wake_tokens,
            token_distance_limit=token_distance_limit,
        )
        if trace_transcripts:
            canonical_combined = " ".join(tokenize_normalized_text(combined_text or normalized_text))
            print(
                "[WakeWord] ASR trace "
                f"tokens={canonical_combined or '<none>'} match={matched} reason={match_reason}"
            )

        if compact_idle_log:
            print(
                "[WakeWord][IDLE] "
                f'heard_raw="{truncate_for_log(text)}" '
                f'heard_norm="{truncate_for_log(normalized_text)}" '
                f"match={matched} reason={match_reason}"
            )

        if matched:
            last_trigger = now
            recent_transcripts = []
            print("WAKE asr:wake_phrase 1.000", flush=True)


def discover_pretrained_model_paths() -> List[str]:
    model_dirs: List[str] = []
    try:
        import openwakeword  # type: ignore

        package_dir = os.path.dirname(openwakeword.__file__ or "")
        if not package_dir:
            package_dir = ""
        model_dirs.append(os.path.join(package_dir, "resources", "models"))
    except Exception:
        pass

    model_dirs.extend(parse_list(os.getenv("WAKE_WORD_MODEL_DIRS", "")))

    discovered: List[str] = []
    for model_dir in model_dirs:
        if not os.path.isdir(model_dir):
            continue
        discovered.extend(glob(os.path.join(model_dir, "*.tflite")))
        discovered.extend(glob(os.path.join(model_dir, "*.onnx")))

    # Keep order stable while removing duplicates.
    return list(dict.fromkeys(discovered))


def resolve_model_paths(model_names: List[str], discovered_paths: List[str]) -> List[str]:
    if not discovered_paths:
        return []

    by_id: Dict[str, str] = {}
    for path in discovered_paths:
        model_id = canonical_model_id(path)
        if model_id not in by_id:
            by_id[model_id] = path

    resolved: List[str] = []
    for model_name in model_names:
        if model_name in by_id:
            resolved.append(by_id[model_name])

    # If requested names are unavailable, pick a reasonable default set.
    if not resolved:
        fallback_ids = resolve_model_names(DEFAULT_MODEL_FALLBACKS)
        for model_id in fallback_ids:
            if model_id in by_id:
                resolved.append(by_id[model_id])

    if not resolved:
        resolved = discovered_paths[:1]

    return list(dict.fromkeys(resolved))


def passive_wait_loop():
    print("[WakeWord] READY (passive mode: no model loaded)", flush=True)
    while True:
        time.sleep(60)


def main():
    wake_words = [normalize_wake_word_name(item) for item in parse_list(os.getenv("WAKE_WORDS", ""))]
    model_paths = parse_list(os.getenv("WAKE_WORD_MODEL_PATHS", ""))
    threshold = float(os.getenv("WAKE_WORD_THRESHOLD", "0.5"))
    cooldown_sec = float(os.getenv("WAKE_WORD_COOLDOWN_SEC", "1.5"))
    debug_enabled = os.getenv("WAKE_WORD_ASR_DEBUG", "true").strip().lower() in {"1", "true", "yes", "on"}
    debug_log_interval_sec = float(os.getenv("WAKE_WORD_ASR_DEBUG_LOG_INTERVAL_SEC", "5.0"))

    if not wake_words and not model_paths:
        wake_words = ["sora"]

    model_names = resolve_model_names(wake_words)
    print(f"[WakeWord] Using wake words: {wake_words}")
    load_targets = []
    if model_paths:
        existing_paths = [path for path in model_paths if os.path.exists(path)]
        missing_paths = [path for path in model_paths if not os.path.exists(path)]
        if missing_paths:
            print(f"[WakeWord] Missing custom model path(s): {missing_paths}", file=sys.stderr)
        if not existing_paths:
            print("[WakeWord] No valid custom model paths found. Entering passive mode.", file=sys.stderr)
            passive_wait_loop()
            return
        load_targets = existing_paths
        print(f"[WakeWord] Using custom model paths: {load_targets}")
    else:
        discovered_paths = discover_pretrained_model_paths()
        resolved_paths = resolve_model_paths(model_names, discovered_paths)
        print(f"[WakeWord] Using model names: {model_names}")
        print(f"[WakeWord] Discovered pretrained model files: {len(discovered_paths)}")
        if resolved_paths:
            print(f"[WakeWord] Loading model files: {resolved_paths}")
            load_targets = resolved_paths
        else:
            print("[WakeWord] No pretrained model files found. Using ASR fallback wake loop.", file=sys.stderr)
            run_asr_wake_loop(wake_words, cooldown_sec=cooldown_sec)
            return

    try:
        model = Model(wakeword_models=load_targets)
    except Exception as e:
        print(f"[WakeWord] Failed to initialize model(s) {load_targets}: {e}", file=sys.stderr)
        passive_wait_loop()
        return

    sox_cmd = build_sox_capture_cmd()
    print(f"[WakeWord] Capture command: {' '.join(sox_cmd)}")

    process = subprocess.Popen(
        sox_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    def cleanup(*_):
        try:
            process.terminate()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    last_trigger = 0.0
    last_debug_log = 0.0
    chunk_samples = 1280
    chunk_bytes = chunk_samples * 2

    print("[WakeWord] READY", flush=True)

    while True:
        if process.stdout is None:
            time.sleep(0.1)
            continue
        data = process.stdout.read(chunk_bytes)
        if not data or len(data) < chunk_bytes:
            time.sleep(0.01)
            continue

        audio = np.frombuffer(data, dtype=np.int16)
        try:
            prediction = cast(Dict[str, float], model.predict(audio))
        except Exception:
            continue

        now = time.time()
        if now - last_trigger < cooldown_sec:
            continue

        if debug_enabled and now - last_debug_log >= debug_log_interval_sec:
            abs_audio = np.abs(audio)
            mean_abs = float(np.mean(abs_audio)) if abs_audio.size else 0.0
            peak_abs = float(np.max(abs_audio)) if abs_audio.size else 0.0
            print(
                "[WakeWord] MODEL monitor "
                f"mean={mean_abs:.1f} peak={peak_abs:.1f} "
                f"top={format_prediction_snapshot(prediction)} threshold={threshold:.2f}"
            )
            last_debug_log = now

        for keyword, score in prediction.items():
            if score >= threshold:
                last_trigger = now
                print(f"WAKE {keyword} {score:.3f}", flush=True)
                break


if __name__ == "__main__":
    main()
