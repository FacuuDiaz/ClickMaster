# Todo corre en containers: no hace falta Node, npm ni MySQL instalados en el host.
# `make help` lista los comandos.

COMPOSE      := docker compose
COMPOSE_PROD := docker compose -f docker-compose.prod.yml
NODE_IMAGE   := node:20-bookworm-slim
# Corre npm dentro de un container, con tu usuario para que los archivos no queden como root
NODE_RUN     := docker run --rm -u $$(id -u):$$(id -g) -e HOME=/tmp -v $(CURDIR):/app -w /app $(NODE_IMAGE)

-include .env
APP_PORT ?= 3000

.DEFAULT_GOAL := help
.PHONY: help env lock setup up down restart build logs ps sync sync-once health \
        db-shell db-checks clean prod-up prod-down prod-logs prod-sync

help: ## Muestra esta ayuda
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(firstword $(MAKEFILE_LIST)) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# ---------- Setup ----------

env: ## Crea .env desde .env.example (si no existe)
	@test -f .env || (cp .env.example .env && echo ".env creado desde .env.example")

lock: ## Genera package-lock.json dentro de un container de Node
	$(NODE_RUN) npm install --package-lock-only --no-audit --no-fund

package-lock.json:
	$(MAKE) lock

setup: env package-lock.json ## Deja todo listo para levantar (.env + lockfile)

# ---------- Local (app + MySQL 8 + API mock) ----------

up: setup ## Levanta todo el entorno local (build incluido)
	$(COMPOSE) up -d --build
	@echo "App: http://localhost:$(APP_PORT)  |  probar con: make health / make sync"

down: ## Baja los containers (conserva los datos de MySQL)
	$(COMPOSE) down

restart: down up ## Baja y vuelve a levantar

build: setup ## Rebuildea la imagen de la app
	$(COMPOSE) build app

logs: ## Sigue los logs de la app
	$(COMPOSE) logs -f app

ps: ## Estado de los containers
	$(COMPOSE) ps

health: ## GET /health
	@curl -s http://localhost:$(APP_PORT)/health; echo

sync: ## Dispara un sync via POST /sync
	@curl -s -X POST http://localhost:$(APP_PORT)/sync; echo

sync-once: setup ## Corre un sync por consola en un container efimero (sin HTTP)
	$(COMPOSE) run --rm --no-deps app node dist/cli.js

db-shell: ## Consola mysql dentro del container
	$(COMPOSE) exec mysql sh -c 'mysql -u"$$MYSQL_USER" -p"$$MYSQL_PASSWORD" "$$MYSQL_DATABASE"'

db-checks: ## Muestra los ultimos chequeos de links
	@$(COMPOSE) exec -T mysql sh -c 'mysql -u"$$MYSQL_USER" -p"$$MYSQL_PASSWORD" "$$MYSQL_DATABASE" -e "SELECT id, sms_content_id, link, http_status, is_ok, response_time_ms, LEFT(error_message, 60) AS error FROM sms_link_checks ORDER BY id DESC LIMIT 20"' 2>/dev/null

clean: ## Baja todo y BORRA los datos de MySQL (volumen)
	$(COMPOSE) down -v

# ---------- Servidor (solo app, red externa tmob_network) ----------

prod-up: setup ## Levanta la app en el servidor
	$(COMPOSE_PROD) up -d --build

prod-down: ## Baja la app en el servidor
	$(COMPOSE_PROD) down

prod-logs: ## Logs de la app en el servidor
	$(COMPOSE_PROD) logs -f app

prod-sync: sync ## Dispara un sync en el servidor
