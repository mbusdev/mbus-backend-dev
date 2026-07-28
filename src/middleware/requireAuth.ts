import { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated()) {
    next();
  } else {
    res.status(401).json({ error: "Authentication required" });
  }
}
