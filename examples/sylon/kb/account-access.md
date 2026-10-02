# Account access

- **Password reset:** use "Forgot password" on the sign-in page. The link is valid for 1 hour.
  Workspaces with SSO enforced cannot reset a Relaybox password; sign in through the identity
  provider instead.
- **Locked out:** 10 failed sign-ins lock the account for 30 minutes.
- **Two-factor authentication:** owners can require it for everyone under **Settings → Security**.
  A user who lost their device can use a recovery code; otherwise a workspace owner can reset
  their 2FA from the member list.
- **Roles:** Owner (billing, security, delete workspace), Admin (members, integrations, exports),
  Member. Only an owner can promote someone to owner.
- **Removing a member** signs them out everywhere and revokes their API tokens immediately.
- **Owner left the company:** support can transfer ownership after verifying a request from
  another admin's verified email.
