import fs from "fs";
import passport from "passport";
import { Strategy as SamlStrategy, type Profile, type VerifiedCallback } from "@node-saml/passport-saml";
import { InternalAccount } from "../db/models/InternalAccount.js";

// ---------- IdP configuration ----------

const IDP_CONFIG = {
  test: {
    entryPoint: "https://shib-idp-staging.dsc.umich.edu/idp/profile/SAML2/Redirect/SSO",
    certPath: "secrets/shibboleth-nonprod-cert.pem",
    logoutUrl: "https://shib-idp-staging.dsc.umich.edu/idp/profile/SAML2/Redirect/SLO",
  },
  production: {
    entryPoint: "https://shibboleth.umich.edu/idp/profile/SAML2/Redirect/SSO",
    certPath: "secrets/shibboleth-production-cert.pem",
    logoutUrl: "https://shibboleth.umich.edu/idp/profile/SAML2/Redirect/SLO",
  },
} as const;

// ---------- Initialization ----------

const samlEnv = (process.env.SAML_ENV ?? "") as keyof typeof IDP_CONFIG;
const idpConf = IDP_CONFIG[samlEnv];

export let samlEnabled = false;
export let samlStrategy: SamlStrategy | null = null;
export let logoutUrl = "";
export const spCertPath = process.env.SAML_SP_CERT ?? "secrets/sp-cert.pem";

if (!idpConf) {
  console.warn(`[SAML] SAML_ENV not set or invalid ("${samlEnv}"). SAML authentication disabled.`);
} else {
  const spKeyPath = process.env.SAML_SP_KEY ?? "secrets/sp-key.pem";
  const idpCertExists = fs.existsSync(idpConf.certPath);
  const spKeyExists = fs.existsSync(spKeyPath);
  const spCertExists = fs.existsSync(spCertPath);

  if (!idpCertExists || !spKeyExists || !spCertExists) {
    const missing = [
      !idpCertExists && idpConf.certPath,
      !spKeyExists && spKeyPath,
      !spCertExists && spCertPath,
    ].filter(Boolean);
    console.warn(`[SAML] Missing certificate files: ${missing.join(", ")}. SAML disabled.`);
  } else {
    const idpCert = fs.readFileSync(idpConf.certPath, "utf-8");
    const spKey = fs.readFileSync(spKeyPath, "utf-8");

    const entityId = process.env.SAML_SP_ENTITY_ID ?? "https://maizebus.app/shibboleth";
    const acsUrl = process.env.SAML_SP_ACS_URL ?? "https://maizebus.app/auth/saml/callback";

    samlStrategy = new SamlStrategy(
      {
        entryPoint: idpConf.entryPoint,
        issuer: entityId,
        callbackUrl: acsUrl,
        cert: idpCert,
        privateKey: spKey,
        decryptionPvk: spKey,
        wantAssertionsSigned: true,
        identifierFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
        signatureAlgorithm: "sha256",
      },
      // Verify callback — runs after a successful SAML assertion
      async (profile: Profile | null, done: VerifiedCallback) => {
        try {
          if (!profile) return done(new Error("No SAML profile returned"));

          // Extract UMich attributes from SAML assertion
          const attrs = (profile as any).attributes ?? profile;
          const uniqname = String(
            attrs["urn:oid:0.9.2342.19200300.100.1.1"] ??
            profile.nameID ??
            "",
          );
          const email = String(
            attrs["urn:oid:0.9.2342.19200300.100.1.3"] ?? "",
          );
          const displayName = String(
            attrs["urn:oid:2.16.840.1.113730.3.1.241"] ??
            attrs["urn:oid:2.5.4.3"] ??
            "",
          );

          if (!uniqname) return done(new Error("No uniqname found in SAML assertion"));

          // Upsert InternalAccount — create on first login, update lastLoginAt on return
          const account = await InternalAccount.findOneAndUpdate(
            { uniqname },
            { lastLoginAt: new Date(), active: true },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );

          const user: Express.User = {
            uniqname,
            email,
            displayName,
            samlNameId: profile.nameID ?? "",
            sessionIndex: (profile as any).sessionIndex ?? "",
            accountId: account._id.toString(),
          };

          done(null, user as unknown as Record<string, unknown>);
        } catch (err) {
          done(err as Error);
        }
      },
      // Logout callback
      (_profile: Profile | null, done: VerifiedCallback) => {
        done(null, {});
      },
    );

    passport.use("saml", samlStrategy);
    logoutUrl = idpConf.logoutUrl;
    samlEnabled = true;
    console.log(`[SAML] Initialized for ${samlEnv} environment (entity: ${entityId})`);
  }
}

// ---------- Passport serialization ----------

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user: Express.User, done) => {
  done(null, user);
});
