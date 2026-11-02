#!/bin/sh
# Generate the per-installation CA and the YouTube leaf.
#
# Every TV owner runs this once: the CA is unique to their installation and must
# be trusted by their TV (the CaBox imports $BASE/share/xwalk_cert/phantom_ca.pem,
# which ytadpatch installs from ca.pem). The repo ships no keys.
#
# The three /usr/share/cert trust bundles are built on the TV itself by
# `ytadpatch install` from the stock bundles plus this ca.pem - they are not
# distributed because every CA differs.
set -e
cd "$(dirname "$0")"

mkdir -p ../tv/tls

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem \
  -days 3650 -subj "/O=PhantomTV/CN=PhantomTV Root CA"
openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr \
  -subj "/O=PhantomTV/CN=www.youtube.com"
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out leaf.pem -days 825 -extfile leaf.cnf -extensions v3
rm -f leaf.csr

cp ca.pem ../tv/tls/ca.pem
cp leaf.pem ../tv/tls/leaf.pem
cp leaf.key ../tv/tls/leaf.key

echo "ca:   $(openssl x509 -in ca.pem -noout -fingerprint -sha256 | cut -d= -f2)"
echo "leaf: $(openssl x509 -in leaf.pem -noout -fingerprint -sha256 | cut -d= -f2)"
echo "keep certs/ca.key private: it signs the leaf your TV trusts"
