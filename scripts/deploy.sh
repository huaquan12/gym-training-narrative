#!/bin/bash
# Deploy gym-training-narrative to PubHTML
# Usage: bash scripts/deploy.sh

set -e

SLUG="gym-narrative"
HTML_FILE="app/index.html"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 Deploying gym-training-narrative..."
echo "   Slug: $SLUG"
echo "   File: $HTML_FILE"

cd "$PROJECT_DIR"

# Step 1: Create page and get store token
echo ""
echo "📦 Step 1: Creating PubHTML page..."
RESPONSE=$(curl -s -X POST "https://api.cuige.xin/v1/pages" \
  -H "Content-Type: application/json" \
  -d "{\"slug\": \"$SLUG\", \"title\": \"训练叙事\"}")

STORE_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('store_token', d.get('storeToken', '')))" 2>/dev/null || echo "")

if [ -z "$STORE_TOKEN" ]; then
  echo "   Page may already exist, trying to get token..."
  RESPONSE=$(curl -s "https://api.cuige.xin/v1/pages/$SLUG")
  STORE_TOKEN=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('store_token', d.get('storeToken', '')))" 2>/dev/null || echo "")
fi

echo "   Store Token: ${STORE_TOKEN:0:10}..."

# Step 2: Inject store token into HTML
echo ""
echo "📝 Step 2: Injecting store token..."
TEMP_HTML=$(mktemp)
sed "s/__STORE_TOKEN__/$STORE_TOKEN/g" "$HTML_FILE" > "$TEMP_HTML"

# Step 3: Upload HTML
echo ""
echo "📤 Step 3: Uploading HTML..."
UPLOAD_RESPONSE=$(curl -s -X PUT "https://api.cuige.xin/v1/pages/$SLUG/html" \
  -H "Content-Type: text/html" \
  -H "Authorization: Bearer $STORE_TOKEN" \
  --data-binary @"$TEMP_HTML")

echo "   Response: $UPLOAD_RESPONSE"

# Clean up
rm -f "$TEMP_HTML"

echo ""
echo "✅ Deployed! Visit: https://pub.cuige.xin/$SLUG"
echo "   Coach view:  https://pub.cuige.xin/$SLUG?role=coach"
echo "   Member view: https://pub.cuige.xin/$SLUG?role=member"
