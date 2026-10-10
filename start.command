#!/bin/bash
# Llama Playground: double-click in Finder to serve this folder and open it in your browser.
# (The page's JavaScript is a module, which browsers won't load straight from a file.)
# Close this window, or press Ctrl-C, to stop.
cd "$(dirname "$0")"
PORT=8000
IP=$(ipconfig getifaddr en0 2>/dev/null)
echo "Llama Playground → http://localhost:$PORT"
[ -n "$IP" ] && echo "On an iPad on the same Wi-Fi → http://$IP:$PORT"
( sleep 1; open "http://localhost:$PORT/" ) &
python3 -m http.server $PORT
