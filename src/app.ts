import "dotenv/config";
import express from "express";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "passport";
import "./auth/saml.js";  // registers passport SAML strategy (side-effect import)
import { connectToDatabase } from "./db/connection.js";
import mbus from "./routes/api.js";
import users from "./routes/users.js";
import auth from "./routes/auth.js";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));  // required to parse SAML POST assertions

// Session — backed by MongoDB via connect-mongo
const mongoUri = process.env.MONGODB_URI ?? "mongodb://localhost:27017/mbus";

app.use(session({
  secret:            process.env.SESSION_SECRET ?? "change-me-in-production",
  resave:            false,
  saveUninitialized: false,
  store:             MongoStore.create({ mongoUrl: mongoUri }),
  cookie: {
    secure:   process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge:   8 * 60 * 60 * 1000,  // 8 hours
    sameSite: "lax",
  },
}));

app.use(passport.initialize());
app.use(passport.session());

app.use("/auth", auth);                    // public — login flow must be accessible
app.use("/mbus/api/v3", mbus);             // transit data (auth gating deferred)
app.use("/mbus/api/v3/account", users);    // requireAuth applied inside users router
app.use("/docs", express.static("docs"));

const PORT = process.env.PORT || 3000;

connectToDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
