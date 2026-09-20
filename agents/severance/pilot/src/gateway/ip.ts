/**
 * True only for a plain dotted-quad public IPv4 unicast address.
 *
 * The gateway sends its Coolify bearer token and every migrated env var to a registered
 * address, so an address that reaches loopback, the gateway's own network or a cloud
 * metadata service turns registration into an SSRF primitive. Hostnames, IPv6, ports,
 * whitespace and leading-zero octets (ambiguous: some parsers read them as octal) are all
 * refused rather than normalised.
 *
 * The documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24) are NOT refused: they
 * are unroutable, so they cannot reach anything, and the fake internet used by every test
 * lives in 203.0.113.0/24.
 */
export function isPublicIPv4(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(s);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([a, b, c, Number(m[4])].some((o) => o > 255)) return false;

  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, incl. the 169.254.169.254 metadata address
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast 224/4 and reserved 240/4, incl. 255.255.255.255
  return true;
}
