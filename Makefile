# Todo corre en containers: no hace falta Node, npm ni MySQL instalados en el host.
# `make help` lista los comandos.

COMPOSE      := docker compose
NODE_IMAGE   := node:20-bookworm-slim
# Corre npm dentro de un container, con tu usuario para que los archivos no queden como root
NODE_RUN     := docker run --rm -u $$(id -u):$$(id -g) -e HOME=/tmp -v $(CURDIR):/app -w /app $(NODE_IMAGE)

-include .env
APP_PORT ?= 3000
API      := http://localhost:$(APP_PORT)
# Si hay ADMIN_TOKEN en .env se manda en cada request.
AUTH     := $(if $(ADMIN_TOKEN),-H 'Authorization: Bearer $(ADMIN_TOKEN)',)
CURL     := curl -s $(AUTH)
# jq si esta instalado, si no el JSON tal cual
PRETTY   := $(if $(shell command -v jq 2>/dev/null),| jq .,; echo)

# Tests: base propia (<DB_NAME>_test, la crean como root), sin scheduler ni worker
# automaticos, con src/ y test/ montados para no tener que rebuildear.
TEST_RUN := $(COMPOSE) run --rm -T \
	-e DB_NAME=$(DB_NAME)_test -e DB_USER=root -e DB_PASSWORD=$(DB_ROOT_PASSWORD) \
	-e SCHEDULER_ENABLED=false -e WORKER_ENABLED=false -e LOG_LEVEL=error \
	-e EDR_URL=http://edr.invalid/ -e EDR_AUTH= \
	-v $(CURDIR)/src:/app/src:ro -v $(CURDIR)/test:/app/test:ro app

.DEFAULT_GOAL := help
.PHONY: help env lock setup up down restart build logs ps health \
        sync ingest ingest-window sync-once edr-probe sync-status runs run queue jobs job recover recover-force \
        clicks clicks-file clicks-status clicks-summary clicks-cancel \
        test test-volume typecheck db-shell db-checks clean

help: ## Muestra esta ayuda
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---------- Setup ----------

env: ## Crea .env desde .env.example (si no existe)
	@test -f .env || (cp .env.example .env && echo ".env creado desde .env.example")

lock: ## Genera package-lock.json dentro de un container de Node
	$(NODE_RUN) npm install --package-lock-only --no-audit --no-fund

package-lock.json:
	$(MAKE) lock

setup: env package-lock.json ## Deja todo listo para levantar (.env + lockfile)

# ---------- Ciclo de vida ----------

up: setup ## Levanta todo (app con scheduler + worker, MySQL y el mock si COMPOSE_PROFILES=mock)
	$(COMPOSE) up -d --build
	@echo "App: $(API)  |  probar con: make health / make sync-status / make queue"

down: ## Baja los containers (conserva los datos de MySQL)
	$(COMPOSE) down

restart: down up ## Baja y vuelve a levantar

build: setup ## Rebuildea la imagen de la app
	$(COMPOSE) build app

logs: ## Sigue los logs de la app (JSON por linea)
	$(COMPOSE) logs -f app

ps: ## Estado de los containers
	$(COMPOSE) ps

health: ## GET /health (base + estado del worker)
	@$(CURL) $(API)/health $(PRETTY)

# ---------- Ingesta EDR ----------
# Normalmente no hace falta: el scheduler pide cada ventana solo.

sync: ## Ingesta YA las ventanas cerradas pendientes (lo mismo que el scheduler)
	@$(CURL) -X POST $(API)/sync $(PRETTY)

ingest: sync ## Alias de sync

ingest-window: ## Ingesta una ventana puntual: make ingest-window START="2026.10.14 09:00:00" END="2026.10.14 09:30:00"
	@test -n "$(START)" -a -n "$(END)" || (echo 'Uso: make ingest-window START="YYYY.MM.DD HH:mm:ss" END="YYYY.MM.DD HH:mm:ss"' && exit 1)
	@$(CURL) -X POST $(API)/sync -H 'Content-Type: application/json' \
		-d '{"start":"$(START)","end":"$(END)"}' $(PRETTY)

sync-once: setup ## Ingesta por consola en un container efimero (sin HTTP)
	$(COMPOSE) run --rm app node dist/cli.js

edr-probe: ## Consulta de diagnostico a la API EDR, sin guardar nada: make edr-probe [START=... END=...]
	$(COMPOSE) run --rm --no-deps -T app node dist/edrProbe.js $(if $(START),"$(START)" "$(END)",)

sync-status: ## Ultima corrida y cursor del scheduler
	@$(CURL) $(API)/sync/status $(PRETTY)

runs: ## Historial de corridas: make runs [STATUS=failed] [LIMIT=20]
	@$(CURL) "$(API)/sync/runs?limit=$(or $(LIMIT),20)$(if $(STATUS),&status=$(STATUS),)" $(PRETTY)

run: ## Detalle de una corrida: make run ID=12
	@$(CURL) $(API)/sync/runs/$(ID) $(PRETTY)

# ---------- Cola de verificacion ----------

queue: ## Resumen de la cola y resultados: make queue [FROM=... TO=...]
	@$(CURL) -G $(API)/processing/summary $(if $(FROM),--data-urlencode "from=$(FROM)",) $(if $(TO),--data-urlencode "to=$(TO)",) $(PRETTY)

jobs: ## Lista trabajos: make jobs [STATUS=failed] [OUTCOME=timeout] [LIMIT=20] [BEFORE=id]
	@$(CURL) -G $(API)/processing/jobs --data-urlencode "limit=$(or $(LIMIT),20)" \
		$(if $(STATUS),--data-urlencode "status=$(STATUS)",) $(if $(OUTCOME),--data-urlencode "outcome=$(OUTCOME)",) \
		$(if $(BEFORE),--data-urlencode "beforeId=$(BEFORE)",) $(PRETTY)

job: ## Detalle de un trabajo con sus intentos: make job ID=123
	@$(CURL) $(API)/processing/jobs/$(ID) $(PRETTY)

recover: ## Devuelve a la cola las reservas vencidas (ya lo hace solo cada minuto)
	@$(CURL) -X POST $(API)/processing/recover $(PRETTY)

recover-force: ## Devuelve a la cola TODO lo que este en processing (solo con una instancia)
	@$(CURL) -X POST $(API)/processing/recover -H 'Content-Type: application/json' -d '{"force":true}' $(PRETTY)

# ---------- Clicks manuales ----------

clicks: ## Lanza un job de clicks: make clicks URL=https://... COUNT=50
	@test -n "$(URL)" -a -n "$(COUNT)" || (echo "Uso: make clicks URL=https://... COUNT=50" && exit 1)
	@$(CURL) -X POST $(API)/clicks -H 'Content-Type: application/json' \
		-d '{"url":"$(URL)","count":$(COUNT)}'; echo

FILE ?= clicks_to_do.txt
clicks-file: ## Un job por linea (url,cantidad) de un archivo: make clicks-file [FILE=clicks_to_do.txt]
	@test -f "$(FILE)" || (echo "No existe $(FILE) (formato: url,cantidad por linea)" && exit 1)
	@$(CURL) -X POST $(API)/clicks/batch -H 'Content-Type: text/plain' \
		--data-binary @"$(FILE)"; echo

clicks-status: ## Estado del job de clicks en curso y los ultimos jobs
	@$(CURL) $(API)/clicks; echo

clicks-summary: ## Progreso resumido de los clicks (job actual, cola y totales)
	@$(COMPOSE) exec -T -e ADMIN_TOKEN=$(ADMIN_TOKEN) app node - < scripts/clicks-summary.js

clicks-cancel: ## Cancela el job de clicks en curso
	@$(CURL) -X POST $(API)/clicks/cancel; echo

# ---------- Tests ----------

typecheck: ## Compila TypeScript sin generar archivos
	$(NODE_RUN) sh -c "npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit"

test: build ## Tests unitarios + integracion (MySQL real, base <DB_NAME>_test) + E2E Playwright
	$(TEST_RUN) npm test

test-volume: build ## Prueba de volumen: 20.000 SMS sinteticos (tiempo, queries, memoria)
	$(TEST_RUN) npm run test:volume

# ---------- MySQL ----------

db-shell: ## Consola mysql dentro del container
	$(COMPOSE) exec mysql sh -c 'mysql -u"$$MYSQL_USER" -p"$$MYSQL_PASSWORD" "$$MYSQL_DATABASE"'

db-checks: ## Muestra los ultimos chequeos de links
	@$(COMPOSE) exec -T mysql sh -c 'mysql -u"$$MYSQL_USER" -p"$$MYSQL_PASSWORD" "$$MYSQL_DATABASE" -e "SELECT id, processing_id, attempt, outcome, http_status, response_time_ms, LEFT(link, 50) AS link, LEFT(error_message, 50) AS error FROM sms_link_checks ORDER BY id DESC LIMIT 20"' 2>/dev/null

clean: ## Baja todo y BORRA los datos de MySQL (volumen)
	$(COMPOSE) down -v
