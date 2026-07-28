declare namespace Express {
  interface User {
    uniqname: string;
    email: string;
    displayName: string;
    samlNameId: string;
    sessionIndex: string;
    accountId?: string;
  }
}
