#!/bin/bash
set -e

echo ""
echo "  Space Goods Cashflow Dashboard"
echo "  ================================"

# Install dependencies if needed
if ! python3 -c "import flask, openpyxl" 2>/dev/null; then
  echo "  Installing dependencies..."
  pip install -r requirements.txt -q
fi

echo "  Starting server at http://localhost:5000"
echo "  Press Ctrl+C to stop."
echo ""

python3 app.py
