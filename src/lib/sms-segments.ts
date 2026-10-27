// GSM-7 alphabet and segment counter for SMS billing.
// Pure function used by SMS send path (server) and SMS composer (browser).

// GSM-7 basic alphabet (3GPP TS 23.038 default alphabet, 0x00–0x7F minus 0x1B escape)
// Explicitly lists all single-byte characters (no character ranges)
// Note: lowercase ç is NOT in GSM-7; uppercase Ç is included
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(
    ""
  )
);

// GSM-7 extension characters (2 units each, includes form feed \f)
const GSM7_EXTENSION = new Set("^{}\\[~]|€\f".split(""));

export interface SmsSegmentInfo {
  encoding: "GSM-7" | "UCS-2";
  units: number;
  segments: number;
}

export function countSmsSegments(text: string): SmsSegmentInfo {
  // Empty text → 0 segments
  if (!text) {
    return { encoding: "GSM-7", units: 0, segments: 0 };
  }

  // Determine encoding and count units
  let isGsm7 = true;
  let units = 0;

  for (const char of text) {
    if (GSM7_BASIC.has(char)) {
      units += 1;
    } else if (GSM7_EXTENSION.has(char)) {
      units += 2;
    } else {
      // Character not in GSM-7 → force UCS-2
      isGsm7 = false;
      break;
    }
  }

  const encoding = isGsm7 ? "GSM-7" : "UCS-2";

  // For UCS-2, count UTF-16 code units
  if (!isGsm7) {
    units = text.length; // JavaScript's .length gives UTF-16 code units
  }

  // Calculate segments
  let segments: number;
  if (encoding === "GSM-7") {
    segments = units <= 160 ? 1 : Math.ceil(units / 153);
  } else {
    segments = units <= 70 ? 1 : Math.ceil(units / 67);
  }

  return { encoding, units, segments };
}
