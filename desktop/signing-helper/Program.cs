// Nabu PDF signing helper — Windows Certificate Store → PKCS#7/CMS.
//
// Two subcommands, both talking JSON on stdout (errors + a short code on stderr,
// non-zero exit). Binary travels through files, never argv:
//
//   nabu-sign list-certs
//       → stdout: JSON array of signing-capable certs (with a private key) found
//         in CurrentUser\My and LocalMachine\My.
//
//   nabu-sign sign --in <tbsFile> --out <derFile> --thumbprint <hex> [--tsa <url>]
//       → reads the to-be-signed bytes from <tbsFile>, produces a DETACHED
//         adbe.pkcs7 CMS (SHA-256, full chain), optionally adds an RFC3161
//         signature timestamp (PAdES-T), writes DER to <derFile>.
//         The token's PIN dialog is shown by its CSP/KSP during signing.
//
// Exit codes:  0 ok · 1 usage/other · 2 sign failed (PIN cancelled / key denied)
//              3 certificate not found · 4 timestamp (TSA) failed
//
// The private key is used in place on the token; it is never read or exported.

using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.Pkcs;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Threading.Tasks;

namespace NabuSign
{
    internal sealed class CertInfo
    {
        public string thumbprint { get; set; }
        public string subject { get; set; }
        public string issuer { get; set; }
        public string serial { get; set; }
        public string cn { get; set; }
        public string email { get; set; }
        public string org { get; set; }
        public string notBefore { get; set; }
        public string notAfter { get; set; }
        public bool expired { get; set; }
        public string store { get; set; }
    }

    internal static class Program
    {
        // SHA-256 digest OID for the CMS SignerInfo.
        private const string OID_SHA256 = "2.16.840.1.101.3.4.2.1";
        // id-aa-signatureTimeStampToken — the RFC3161 token as an unsigned attr.
        private const string OID_SIG_TIMESTAMP = "1.2.840.113549.1.9.16.2.14";

        private static async Task<int> Main(string[] args)
        {
            // JSON on stdout must be UTF-8 so Vietnamese in cert subjects survives.
            try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch { }
            try
            {
                if (args.Length == 0) { Err("no command (expected: list-certs | sign)"); return 1; }
                switch (args[0])
                {
                    case "list-certs": return ListCerts();
                    case "sign": return await Sign(ParseOpts(args)).ConfigureAwait(false);
                    default: Err("unknown command: " + args[0]); return 1;
                }
            }
            catch (Exception ex)
            {
                Err(ex.Message);
                return 1;
            }
        }

        private static Dictionary<string, string> ParseOpts(string[] args)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < args.Length; i++)
            {
                if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
                var key = args[i].Substring(2);
                var val = (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal)) ? args[++i] : "";
                d[key] = val;
            }
            return d;
        }

        private static void Err(string m) => Console.Error.WriteLine(m);

        // --- list-certs -----------------------------------------------------

        private static int ListCerts()
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var list = new List<CertInfo>();
            foreach (var loc in new[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine })
            {
                using (var store = new X509Store(StoreName.My, loc))
                {
                    try { store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly); }
                    catch { continue; }
                    foreach (var c in store.Certificates)
                    {
                        try
                        {
                            if (!c.HasPrivateKey || !CanSign(c)) continue;
                            if (c.Thumbprint == null || !seen.Add(c.Thumbprint)) continue;
                            var now = DateTime.Now;
                            list.Add(new CertInfo
                            {
                                thumbprint = c.Thumbprint,
                                subject = c.Subject,
                                issuer = c.Issuer,
                                serial = c.SerialNumber,
                                cn = SafeName(c, X509NameType.SimpleName),
                                email = SafeName(c, X509NameType.EmailName),
                                org = RdnValue(c.Subject, "O"),
                                notBefore = c.NotBefore.ToUniversalTime().ToString("o"),
                                notAfter = c.NotAfter.ToUniversalTime().ToString("o"),
                                expired = now < c.NotBefore || now > c.NotAfter,
                                store = loc.ToString(),
                            });
                        }
                        catch { /* skip an unreadable cert, keep the rest */ }
                    }
                }
            }
            Console.Out.Write(JsonSerializer.Serialize(list));
            return 0;
        }

        // A cert is signing-capable if it has no KeyUsage restriction, or asserts
        // digitalSignature / nonRepudiation. VN CA end-entity certs assert these.
        private static bool CanSign(X509Certificate2 c)
        {
            foreach (var ext in c.Extensions)
            {
                if (ext is X509KeyUsageExtension ku)
                {
                    var f = ku.KeyUsages;
                    return (f & X509KeyUsageFlags.DigitalSignature) != 0
                        || (f & X509KeyUsageFlags.NonRepudiation) != 0;
                }
            }
            return true;
        }

        private static string SafeName(X509Certificate2 c, X509NameType t)
        {
            try { return c.GetNameInfo(t, false) ?? ""; } catch { return ""; }
        }

        // Pull one RDN value (e.g. "O") out of a distinguished name string.
        private static string RdnValue(string dn, string rdn)
        {
            if (string.IsNullOrEmpty(dn)) return "";
            foreach (var part in dn.Split(','))
            {
                var t = part.Trim();
                if (t.StartsWith(rdn + "=", StringComparison.OrdinalIgnoreCase))
                    return t.Substring(rdn.Length + 1).Trim();
            }
            return "";
        }

        // --- sign -----------------------------------------------------------

        private static async Task<int> Sign(Dictionary<string, string> o)
        {
            if (!o.TryGetValue("in", out var inPath) || string.IsNullOrEmpty(inPath) ||
                !o.TryGetValue("out", out var outPath) || string.IsNullOrEmpty(outPath) ||
                !o.TryGetValue("thumbprint", out var thumb) || string.IsNullOrEmpty(thumb))
            {
                Err("sign requires --in <file> --out <file> --thumbprint <hex>");
                return 1;
            }
            o.TryGetValue("tsa", out var tsa);

            var cert = FindCert(thumb);
            if (cert == null) { Err("certificate not found: " + thumb); return 3; }
            if (!cert.HasPrivateKey) { Err("certificate has no accessible private key"); return 3; }

            byte[] data = File.ReadAllBytes(inPath);
            var cms = new SignedCms(new ContentInfo(data), detached: true);
            var signer = new CmsSigner(cert)
            {
                DigestAlgorithm = new Oid(OID_SHA256),
                IncludeOption = X509IncludeOption.WholeChain,
            };
            // Acrobat-style adbe.pkcs7.detached: include a signingTime signed attr.
            signer.SignedAttributes.Add(new Pkcs9SigningTime(DateTime.UtcNow));

            try
            {
                // silent:false → let the token's CSP/KSP pop its PIN dialog.
                cms.ComputeSignature(signer, false);
            }
            catch (CryptographicException ex)
            {
                Err("sign_failed: " + ex.Message);
                return 2; // PIN cancelled / key access denied / no key material
            }

            if (!string.IsNullOrWhiteSpace(tsa))
            {
                try { await AddTimestamp(cms, tsa).ConfigureAwait(false); }
                catch (Exception ex) { Err("tsa_failed: " + ex.Message); return 4; }
            }

            File.WriteAllBytes(outPath, cms.Encode());
            Console.Out.Write(JsonSerializer.Serialize(new
            {
                ok = true,
                cert = cert.Subject,
                timestamped = !string.IsNullOrWhiteSpace(tsa),
            }));
            return 0;
        }

        private static X509Certificate2 FindCert(string thumb)
        {
            thumb = thumb.Replace(" ", "").Replace(":", "").ToUpperInvariant();
            foreach (var loc in new[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine })
            {
                // Deliberately NOT disposing the store here: on some CNG/CSP tokens
                // disposing the store before ComputeSignature can invalidate the
                // returned cert's private-key handle. This is a one-shot process, so
                // the store handle is reclaimed at exit anyway.
                var store = new X509Store(StoreName.My, loc);
                try { store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly); }
                catch { continue; }
                var found = store.Certificates.Find(X509FindType.FindByThumbprint, thumb, false);
                if (found.Count > 0) return found[0];
            }
            return null;
        }

        // PAdES-T: request an RFC3161 token over the signature and attach it as the
        // id-aa-signatureTimeStampToken unsigned attribute on the signer.
        private static async Task AddTimestamp(SignedCms cms, string tsaUrl)
        {
            SignerInfo si = cms.SignerInfos[0];
            Rfc3161TimestampRequest req = Rfc3161TimestampRequest.CreateFromSignerInfo(
                si, HashAlgorithmName.SHA256, requestSignerCertificates: true);

            byte[] reqBytes = req.Encode();
            byte[] respBytes;
            using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) })
            using (var content = new ByteArrayContent(reqBytes))
            {
                content.Headers.ContentType = new MediaTypeHeaderValue("application/timestamp-query");
                using (var resp = await http.PostAsync(tsaUrl, content).ConfigureAwait(false))
                {
                    resp.EnsureSuccessStatusCode();
                    respBytes = await resp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
                }
            }

            Rfc3161TimestampToken token = req.ProcessResponse(respBytes, out _);
            byte[] tokenDer = token.AsSignedCms().Encode();
            si.AddUnsignedAttribute(new AsnEncodedData(new Oid(OID_SIG_TIMESTAMP), tokenDer));
        }
    }
}
