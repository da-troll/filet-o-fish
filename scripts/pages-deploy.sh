#!/bin/bash
# Deploy dist/ + functions/ to Cloudflare Pages and attach fish.trollefsen.com (HIVE-1438).
# The API token never touches this box: every call runs under Agent Vault (vault "cloudflare", service
# cloudflare-api on api.cloudflare.com), which injects the bearer. wrangler gets a placeholder.
#   scripts/pages-deploy.sh            build, deploy, ensure the custom domain + DNS
#   scripts/pages-deploy.sh --deploy   build + deploy only (later releases)
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=fishfarming-incidents-norway
DOMAIN=fish.trollefsen.com
ZONE=trollefsen.com
WRANGLER=(npx -y wrangler@4.152.0)
AGENT="${BRIDGE_AGENT_ID:-eve}"; [ "$AGENT" = main ] && AGENT=eve
vrun() {
  AGENT_VAULT_TOKEN="$(cat "/home/eve/config/agent-vault/${AGENT}-default.token")" AGENT_VAULT_ADDR=http://127.0.0.1:14321 \
    AGENT_VAULT_VAULT=cloudflare /usr/local/bin/agent-vault vault run --isolation host -- "$@" 2> >(grep -v '^agent-vault' >&2)
}
api() { vrun curl -sS -H 'Authorization: Bearer placeholder' -H 'Content-Type: application/json' "$@"; }
ok() { python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else "API error: "+json.dumps(d.get("errors")))'; }

ACCOUNT=$(api https://api.cloudflare.com/client/v4/accounts | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; assert len(r)==1, r; print(r[0]["id"])')
echo "account $ACCOUNT"
npm ci --no-audit --no-fund --silent && npm test --silent && npm run build --silent
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT"
if ! api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT" | ok 2>/dev/null; then
  vrun env CLOUDFLARE_API_TOKEN=placeholder CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" "${WRANGLER[@]}" pages project create "$PROJECT" --production-branch main
fi
vrun env CLOUDFLARE_API_TOKEN=placeholder CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" "${WRANGLER[@]}" pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true
[ "${1:-}" = --deploy ] && exit 0

# custom domain on the project, then point DNS at it (the record today is the box)
api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT/domains" --data "{\"name\":\"$DOMAIN\"}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("domain:", "added" if d.get("success") else d.get("errors"))'
ZID=$(api "https://api.cloudflare.com/client/v4/zones?name=$ZONE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])')
REC=$(api "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?name=$DOMAIN")
echo "$REC" | python3 -c 'import json,sys; [print("dns before:", r["type"], "(content withheld: the origin IP, HIVE-1432)" if r["type"] in ("A", "AAAA") else r["content"], "proxied" if r["proxied"] else "dns-only") for r in json.load(sys.stdin)["result"]]'
BODY="{\"type\":\"CNAME\",\"name\":\"$DOMAIN\",\"content\":\"$PROJECT.pages.dev\",\"proxied\":true,\"comment\":\"HIVE-1438: Cloudflare Pages\"}"
# shortcut: handles one existing record (today's single A); an A+AAAA pair stops here for a hand decision
RID=$(echo "$REC" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if len(r)==1 else "")')
if [ -n "$RID" ]; then api -X PUT "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records/$RID" --data "$BODY" | ok
else api -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records" --data "$BODY" | ok; fi
echo "dns after: CNAME $PROJECT.pages.dev proxied"
