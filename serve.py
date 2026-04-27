import http.server, os
os.chdir("/Users/bangbong/Desktop/fr-workwear-app")
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=8787, bind="127.0.0.1")
