# AWS policies for 99warehousing

IAM rejects a policy document containing anything other than `Version`, `Id`
and `Statement`, so the JSON files beside this one carry no comments. The
explanation lives here instead.

Replace `REGION` and `ACCOUNT_ID` in each file before pasting it into the
console.

**Region is `ap-southeast-2` (Sydney), and not by choice.** The account sits
under an AWS Organization whose service control policy denies DynamoDB
everywhere else — ap-south-1, ap-southeast-1, us-east-1, us-west-2,
eu-west-1, eu-central-1 and ap-northeast-1 were all tested and all refused
with `explicit deny in a service control policy`. Sydney was the only region
that answered.

It is reachable from the cPanel host, which is what matters, but it is the
slowest of the three that were measured from there:

| Region | TCP connect from the cPanel host |
|---|---|
| ap-southeast-1 (Singapore) | 0.113s |
| ap-south-1 (Mumbai) | 0.210s |
| **ap-southeast-2 (Sydney)** | **0.334s** |

If whoever administers the Organization can allow ap-southeast-1, every
database round trip gets roughly three times closer. Worth asking before
accepting Sydney permanently.

| File | Who holds it | Why |
|---|---|---|
| `aws-dynamodb-policy.json` | the API, permanently | Read and write this app's own tables. No `CreateTable`, no `DeleteTable`, and no reach into any other table in the account. |
| `aws-dynamodb-setup-policy.json` | **temporarily**, to create the tables | `CreateTable` and the TTL calls that `npm run dynamo:create-tables` needs. Detach it once the tables exist — the running API never needs to create a table, and a key that can is a key that can be made to. |
| `aws-s3-policy.json` | the API, only if images move to S3 | Object access on one bucket and nothing else. |

Both DynamoDB policies are scoped to `99w_*`, the prefix in
`src/db/dynamo/tables.js` (`DYNAMO_TABLE_PREFIX`). Change the prefix and the
policies must change with it, or every call returns AccessDenied.

`ListTables` cannot be scoped to a prefix — the API models it as an
account-wide action — so it is a statement of its own in the setup policy and
is absent from the runtime one, which never lists tables.

## The tables these cover

    99w_users        email-index, googleId-index, role-createdAt-index
    99w_properties   status-createdAt-index, owner-createdAt-index, city-createdAt-index
    99w_favorites    (none)
    99w_enquiries    user-createdAt-index, property-createdAt-index, feed-createdAt-index
    99w_reviews      id-index, status-createdAt-index
    99w_auditlogs    feed-createdAt-index
    99w_images       property-createdAt-index

## Credentials

The cPanel host has no instance role, so this needs a long-lived access key
in `server/env` — the one case the DynamoDB client's comment calls out. Keep
`~/nodeapp` outside `public_html`: Apache serves anything inside it as plain
text, and that directory already holds the database password.
