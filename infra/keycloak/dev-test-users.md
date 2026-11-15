# Local dev test accounts

The dev Keycloak (Aspire) is ephemeral: it re-imports the realm and forgets users on every run.
Register these through the sign-in page when testing locally; verification emails land in Mailpit
(see the `mailpit` resource's "ui" endpoint in the Aspire dashboard). Never use these anywhere else.

| Email | Password |
|---|---|
| thandi@kitty.test | Kitty-dev-0de629e963d7 |
| sipho@kitty.test | Kitty-dev-f3adbe98804e |
