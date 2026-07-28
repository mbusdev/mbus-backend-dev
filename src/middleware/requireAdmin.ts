import { Request, Response, NextFunction } from "express";
import { InternalAccount } from "../db/models/InternalAccount.js";

/**
 * Requires the user to be authenticated AND have the "admin" role.
 * Must be used after requireAuth or on routes where requireAuth is already applied.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const account = await InternalAccount.findById(req.user!.accountId);
    if (!account || !account.roles.includes("admin")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}
