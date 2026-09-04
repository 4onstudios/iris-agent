.PHONY: test run dev

NODE ?= npm

test:
	$(NODE) test -- --runInBand --forceExit

run:
	$(NODE) start

dev:
	$(NODE) run dev
