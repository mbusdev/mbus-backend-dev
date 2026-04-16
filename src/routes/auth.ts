import express from "express";
import fs from "fs";
import passport from "passport";
import { samlEnabled, samlStrategy, logoutUrl, spCertPath } from "../auth/saml.js";

const router = express.Router();

const unavailable = (_req: express.Request, res: express.Response) =>
  res.status(503).json({ error: "SAML not configured — see secrets/ directory" });

// GET /auth/login — redirect browser to UMich IdP
router.get(
  "/login",
  samlEnabled ? passport.authenticate("saml") : unavailable,
);

// POST /auth/saml/callback — UMich IdP posts the SAML assertion here
router.post(
  "/saml/callback",
  samlEnabled
    ? passport.authenticate("saml", { failureRedirect: "/auth/login" })
    : unavailable,
  (_req, res) => {
    res.redirect("/");
  },
);

// GET /auth/logout — end local session and redirect to IdP SLO
router.get("/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.redirect(logoutUrl || "/");
    });
  });
});

// GET /auth/me — return current session user
router.get("/me", (req, res) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json(req.user);
});

// GET /auth/saml/metadata — serve SP metadata XML for submission to UMich IAM
router.get("/saml/metadata", (req, res) => {
  if (!samlEnabled || !samlStrategy) return unavailable(req, res);
  const spCert = fs.existsSync(spCertPath)
    ? fs.readFileSync(spCertPath, "utf-8")
    : null;
  res.type("application/xml");
  res.send(samlStrategy.generateServiceProviderMetadata(null, spCert));
});

export default router;
