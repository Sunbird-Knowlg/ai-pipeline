.PHONY: install-core install-jobs install test test-integration lint \
        dev-up dev-down \
        package-enrichment-router package-caption-generator \
        submit-router submit-capgen

install-core:
	pip install -e "core/[dev,test]"

install-jobs:
	pip install -e "jobs/enrichment_router/[test]" -e "jobs/caption_generator/[test]"

install: install-core install-jobs

test:
	pytest core/tests jobs/enrichment_router/tests jobs/caption_generator/tests -m "not integration"

test-integration:
	pytest core/tests jobs/enrichment_router/tests jobs/caption_generator/tests -m integration

lint:
	ruff check core jobs
	mypy core/sunbird_ai_core jobs/enrichment_router/enrichment_router jobs/caption_generator/caption_generator

dev-up:
	docker-compose -f docker/docker-compose.yml up -d

dev-down:
	docker-compose -f docker/docker-compose.yml down

package-enrichment-router:
	rm -rf dist/enrichment-router
	pip install -e core/ -t dist/enrichment-router/
	pip install -e jobs/enrichment_router/ -t dist/enrichment-router/
	mkdir -p artifacts
	cd dist/enrichment-router && zip -rq ../../artifacts/enrichment-router.zip .

package-caption-generator:
	rm -rf dist/caption-generator
	pip install -e core/ -t dist/caption-generator/
	pip install -e jobs/caption_generator/ -t dist/caption-generator/
	mkdir -p artifacts
	cd dist/caption-generator && zip -rq ../../artifacts/caption-generator.zip .

submit-router:
	flink run -py jobs/enrichment_router/enrichment_router/main.py \
		-pyfs artifacts/enrichment-router.zip \
		--config jobs/enrichment_router/config.yaml

submit-capgen:
	flink run -py jobs/caption_generator/caption_generator/main.py \
		-pyfs artifacts/caption-generator.zip \
		--config jobs/caption_generator/config.yaml
