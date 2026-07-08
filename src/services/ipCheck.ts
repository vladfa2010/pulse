/**
 * =============================================================================
 * PULSE — IP/CIDR validation helpers
 * =============================================================================
 */

import { IncomingHttpHeaders } from 'http';

const YOOKASSA_CIDRS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32',
];

function ipToBigInt(ip: string): bigint {
  if (ip.includes(':')) {
    // IPv6
    const parts = ip.split(':');
    // Expand ::
    const emptyIndex = parts.findIndex((p) => p === '');
    let expanded: string[];
    if (emptyIndex !== -1) {
      const nonEmptyCount = parts.filter((p) => p !== '').length;
      const missing = 8 - nonEmptyCount;
      const fill = Array(missing).fill('0000');
      expanded = [];
      let replaced = false;
      for (const p of parts) {
        if (p === '') {
          if (!replaced) {
            expanded.push(...fill);
            replaced = true;
          }
          // skip other empty groups caused by leading/trailing ::
        } else {
          expanded.push(p);
        }
      }
    } else {
      expanded = parts;
    }
    let value = BigInt(0);
    for (const part of expanded) {
      value = (value << BigInt(16)) | BigInt(parseInt(part || '0', 16));
    }
    return value;
  }
  // IPv4
  return ip.split('.').reduce((acc, octet) => (acc << BigInt(8)) | BigInt(parseInt(octet, 10)), BigInt(0));
}

function parseCidr(cidr: string): { network: bigint; prefix: number; isV6: boolean } {
  const [networkStr, prefixStr] = cidr.split('/');
  return {
    network: ipToBigInt(networkStr),
    prefix: parseInt(prefixStr, 10),
    isV6: networkStr.includes(':'),
  };
}

function maskForPrefix(prefix: number, isV6: boolean): bigint {
  const total = isV6 ? 128 : 32;
  return ((BigInt(1) << BigInt(prefix)) - BigInt(1)) << BigInt(total - prefix);
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const { network, prefix, isV6 } = parseCidr(cidr);
    const ipValue = ipToBigInt(ip);
    const mask = maskForPrefix(prefix, isV6);
    return (ipValue & mask) === (network & mask);
  } catch {
    return false;
  }
}

export function isYookassaIp(ip: string): boolean {
  return YOOKASSA_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

export function getClientIp(headers: IncomingHttpHeaders, reqIp?: string): string | undefined {
  const forwarded = headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded)) {
    return forwarded[0].split(',')[0].trim();
  }
  return reqIp;
}
