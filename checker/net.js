// Network lookups: RDAP for registration expiry, a TLS handshake for the certificate.
import tls from 'node:tls';
import { parseRdap } from './lib.js';

export async function lookupRdap(domain, { timeoutMs = 15000 } = {}) {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: 'application/rdap+json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { expiresAt: null, registrar: null, error: 'Registry has no RDAP record for this domain' };
    if (!res.ok) return { expiresAt: null, registrar: null, error: `RDAP lookup failed (HTTP ${res.status})` };
    const parsed = parseRdap(await res.json());
    return { ...parsed, error: parsed.expiresAt ? null : 'Registry does not publish an expiry date' };
  } catch (e) {
    return { expiresAt: null, registrar: null, error: `RDAP lookup failed (${e.name === 'TimeoutError' ? 'timeout' : e.message})` };
  }
}

export function lookupTls(hostname, { port = 443, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish({ expiresAt: null, issuer: null, error: 'No certificate presented' });
      const expiresAt = new Date(cert.valid_to).toISOString();
      const issuer = cert.issuer?.O ? [cert.issuer.O, cert.issuer.CN].filter(Boolean).join(' ') : cert.issuer?.CN || null;
      let error = null;
      if (!socket.authorized) {
        const code = String(socket.authorizationError || '');
        // An expired cert is reported through its date, not as an error.
        if (code !== 'CERT_HAS_EXPIRED') error = describeTlsError(code);
      }
      if (!error) {
        const mismatch = tls.checkServerIdentity(hostname, cert);
        if (mismatch) error = `Certificate does not cover ${hostname}`;
      }
      finish({ expiresAt, issuer, error });
    });
    socket.on('timeout', () => finish({ expiresAt: null, issuer: null, error: 'Connection to port 443 timed out' }));
    socket.on('error', (e) => finish({ expiresAt: null, issuer: null, error: describeTlsError(e.code || e.message) }));
  });
}

function describeTlsError(code) {
  const known = {
    ENOTFOUND: 'Hostname does not resolve (DNS)',
    ECONNREFUSED: 'Nothing is listening on port 443',
    ECONNRESET: 'Connection was reset during the TLS handshake',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Certificate is self-signed',
    SELF_SIGNED_CERT_IN_CHAIN: 'Certificate chain contains a self-signed certificate',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Certificate chain is incomplete (missing intermediate)',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'Certificate chain is incomplete (missing intermediate)',
    CERT_NOT_YET_VALID: 'Certificate is not valid yet',
  };
  return known[code] || `TLS check failed (${code})`;
}
