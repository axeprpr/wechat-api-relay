APP := wechat-api-relay

.PHONY: build backend frontend package clean

build: backend frontend

backend:
	go build -o dist/$(APP) .

frontend:
	cd web && npm install && npm run build

package: build
	VERSION=$${VERSION:-0.1.0} && \
	mkdir -p dist/packages && \
	nfpm package --config packaging/nfpm.yaml --target dist/packages/$(APP)-$$VERSION-linux-amd64.deb && \
	nfpm package --config packaging/nfpm.yaml --packager rpm --target dist/packages/$(APP)-$$VERSION-linux-amd64.rpm

clean:
	rm -rf dist
