/**
 * DXF text decoding. AutoCAD 2007+ (AC1021 and later) writes UTF-8. Earlier versions write the
 * ANSI code page named in $DWGCODEPAGE, e.g. ANSI_949 for Korean or ANSI_1252 for Western text.
 */
const CODE_PAGES: Record<string, string> = {
  ANSI_874: "windows-874",
  ANSI_932: "shift_jis",
  ANSI_936: "gbk",
  ANSI_949: "euc-kr",
  ANSI_950: "big5",
  ANSI_1250: "windows-1250",
  ANSI_1251: "windows-1251",
  ANSI_1252: "windows-1252",
  ANSI_1253: "windows-1253",
  ANSI_1254: "windows-1254",
  ANSI_1255: "windows-1255",
  ANSI_1256: "windows-1256",
  ANSI_1257: "windows-1257",
  ANSI_1258: "windows-1258",
  DOS932: "shift_jis",
  DOS936: "gbk",
  DOS949: "euc-kr",
  DOS950: "big5",
};

/** A header variable's value: the line after "9 / $NAME" and its group code. */
function headerValue(header: string, name: string): string | undefined {
  const match = header.match(
    new RegExp(`(?:^|\\n)\\s*9\\s*\\r?\\n\\s*\\${name}\\s*\\r?\\n\\s*\\d+\\s*\\r?\\n([^\\r\\n]*)`),
  );
  return match?.[1].trim();
}

/** Legacy encoding declared by the header, when it is not UTF-8. */
export function declaredDxfEncoding(buffer: Buffer): string | undefined {
  // Header variables are ASCII; latin1 maps bytes one-to-one for the search.
  const header = buffer.subarray(0, 512 * 1024).toString("latin1");
  const version = headerValue(header, "$ACADVER") ?? "";
  if (/^AC\d{4}$/.test(version) && Number(version.slice(2)) >= 1021) return;
  return CODE_PAGES[(headerValue(header, "$DWGCODEPAGE") ?? "").toUpperCase()] ?? "windows-1252";
}

export function decodeDxf(buffer: Buffer): string {
  // Valid UTF-8 (including plain ASCII) is decoded as UTF-8: legacy multibyte and
  // Windows code-page text practically never forms valid UTF-8 sequences.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    const encoding = declaredDxfEncoding(buffer) ?? "windows-1252";
    try {
      return new TextDecoder(encoding).decode(buffer);
    } catch {
      return buffer.toString("utf8");
    }
  }
}
