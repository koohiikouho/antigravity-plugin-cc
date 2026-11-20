// Scan an `agy` --log-file (and other error text) for what print mode hides.
//
// agy 1.5.x reports most failures in the stream-json `result` event and on
// stderr; the log file remains a useful secondary source (e.g. quota details,
// older agy versions that exited 0 with empty stdout).

/**
 * @param {string} logText raw contents of the agy log file (may be "")
 * @returns {{
 *   conversationId: string|null,
 *   error: { kind: "quota"|"auth"|"model"|"denied"|"backend", message: string, resetsIn: string|null } | null,
 *   errorLines: string[]
 * }}
 */
export function scanAgyLog(logText) {
  const text = typeof logText === "string" ? logText : "";

  const conversationId = extractConversationId(text);
  const errorLines = extractErrorLines(text);
  const error = classifyError(errorLines);

  return { conversationId, error, errorLines };
}

function extractConversationId(text) {
  // Prefer the explicit "Created conversation <uuid>" then "conversation=<uuid>".
  const created = text.match(/Created conversation ([0-9a-fA-F-]{8,})/);
  if (created) return created[1];
  const eq = text.match(/conversation=([0-9a-fA-F-]{8,})/);
  if (eq) return eq[1];
  return null;
}

function extractErrorLines(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // glog/klog style: severity letter prefix E/F at the very start.
    const isErrorSeverity = /^[EF]\d{4}\s/.test(line);
    const looksLikeError =
      /RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED|agent executor error|code 4\d{2}|code 5\d{2}|quota|not authenticated|login required/i.test(
        line,
      );
    if (isErrorSeverity || looksLikeError) {
      out.push(line);
    }
  }
  // De-duplicate repeats (agy logs the same error twice).
  return dedupe(out);
}

function classifyError(errorLines) {
  if (errorLines.length === 0) return null;
  const specific = classifyErrorText(errorLines.join("\n"));
  if (specific) return specific;

  // Generic backend failure: surface the most informative, most recent line.
  const informative =
    [...errorLines].reverse().find((l) => /agent executor error|code \d{3}/i.test(l)) ||
    errorLines[errorLines.length - 1];
  return {
    kind: "backend",
    message: stripGlogPrefix(informative),
    resetsIn: null,
  };
}

const DENIED_RE = /auto-denied|cannot prompt for|user denied perm|PERMISSION_DENIED/i;

function findLine(text, re) {
  return text.split(/\r?\n/).find((l) => re.test(l)) || "";
}

/**
 * Classify free-form error text (agy result.error, stderr, or log lines).
 * Returns null when nothing recognizable is found.
 *
 * PERMISSION_DENIED is NOT treated as an auth failure: in headless runs it means
 * a tool action was denied, not that the user is signed out.
 */
export function classifyErrorText(text) {
  const joined = String(text || "");
  if (!joined.trim()) return null;

  if (/RESOURCE_EXHAUSTED|Individual quota reached|quota (?:exhausted|exceeded|reached)/i.test(joined)) {
    const reset = joined.match(/Resets in ([0-9hms]+)/i);
    return {
      kind: "quota",
      message: "Antigravity quota exhausted (RESOURCE_EXHAUSTED 429).",
      resetsIn: reset ? reset[1] : null,
    };
  }

  if (/UNAUTHENTICATED|not authenticated|authentication required|login required|not signed in/i.test(joined)) {
    return {
      kind: "auth",
      message: "Antigravity is not authenticated. Run `! agy` once to sign in.",
      resetsIn: null,
    };
  }

  const modelRe = /invalid model selection|not recognized as a known model|--effort is not supported|conflicts with --effort/i;
  if (modelRe.test(joined)) {
    return { kind: "model", message: findLine(joined, modelRe).replace(/^error:\s*/i, "").trim(), resetsIn: null };
  }

  if (DENIED_RE.test(joined)) {
    return { kind: "denied", message: stripGlogPrefix(findLine(joined, DENIED_RE)), resetsIn: null };
  }

  return null;
}

function stripGlogPrefix(line) {
  // Turn "E0531 16:30:43.195032 38848 log.go:398] message" into "message".
  return String(line)
    .replace(/^[EFIW]\d{4}\s[\d:.]+\s+\d+\s+\S+\]\s*/, "")
    .trim();
}

function dedupe(lines) {
  // agy logs the same error twice — once wrapped in "agent executor error: <X>"
  // and once as the bare "<X>" — so drop any line whose message is contained in
  // a longer one (or repeats an earlier identical one). Original log order is
  // preserved so the last line is still the latest.
  const keyed = lines.map((line, index) => ({ line, index, key: stripGlogPrefix(line) }));
  return keyed
    .filter(
      (item) =>
        !keyed.some(
          (other) =>
            other !== item &&
            (other.key.length > item.key.length
              ? other.key.includes(item.key)
              : other.key === item.key && other.index < item.index),
        ),
    )
    .map((k) => k.line);
}

export { stripGlogPrefix };
