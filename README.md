# photon-to-n8n

Pont Docker entre [Photon iMessage](https://photon.codes/platform/imessage) et n8n.

## Architecture

Le pont utilise le SDK officiel `@photon-ai/advanced-imessage` (transport gRPC) pour parler directement au service cloud de Photon — pas d'appel REST deviné, pas de webhook public à exposer :

| Sens | Comment | Détail |
|---|---|---|
| Photon → pont | Connexion **gRPC sortante persistante** ouverte par le pont vers `imessage.spectrum.photon.codes:443` | Le pont s'abonne au flux d'évènements (`messages.subscribeEvents()`) ; à chaque `message.received`, il relaie vers `N8N_WEBHOOK_URL` |
| n8n → pont | `POST http://photon-imessage-bridge:8105/send` (réseau Docker interne) | Le pont appelle `messages.sendText(...)` sur le même client gRPC |
| Pont → Photon (auth) | `POST https://spectrum.photon.codes/projects/{id}/imessage/tokens` (Basic Auth `projectId:projectSecret`) | Récupère un token de courte durée, renouvelé automatiquement avant expiration |

**Conséquence importante : aucun port n'a besoin d'être exposé publiquement.** Le pont initie toutes les connexions vers Photon (sortant), et n8n l'appelle en interne via `nexus-network`. Pas de NPM, pas de certificat, pas de webhook à enregistrer côté Photon pour la réception.

Ces détails (endpoints, format du token, adresse gRPC partagée) viennent directement du code source publié des packages npm `@spectrum-ts/core`, `@spectrum-ts/imessage` et `@photon-ai/advanced-imessage` (pas de la doc `docs.photon.codes`, bloquée en 403 pour les fetchs automatisés) — donc fiables, pas devinés.

## Installation

```bash
cp .env.example .env
```

Édite `.env` :
- `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` — dans `app.photon.codes` → ton projet → Settings ("Project ID" / "Secret Key")
- `N8N_WEBHOOK_URL` — déjà réglé sur `https://n8n1.voituredujour.duckdns.org/webhook/photon`
- `SEND_AUTH_TOKEN` — optionnel, protège `/send` par un header partagé

```bash
docker compose -p photon-to-n8n up -d --build
```

`nexus-network` est déclaré comme réseau externe (mappé sur `mon-serveur_nexus-network` — vérifiable avec `docker network ls`) ; comme n8n y est déjà, il n'y a rien d'autre à faire côté réseau.

## Configuration côté n8n

### 1. Recevoir les messages entrants — node **Webhook** (trigger)

- Node : `Webhook`
- HTTP Method : `POST`
- Path : `photon`
- Respond : `Immediately`

Le body reçu est celui envoyé par le pont :
```json
{
  "chatGuid": "any;-;+15551234567",
  "from": "+15551234567",
  "text": "salut",
  "messageGuid": "...",
  "occurredAt": "2026-07-27T..."
}
```

### 2. Envoyer un message — node **HTTP Request**

- Node : `HTTP Request`
- Method : `POST`
- URL : `http://photon-imessage-bridge:8105/send`
- Body Content Type : `JSON`
- Body :
  ```json
  {
    "to": "={{ $json.to }}",
    "text": "={{ $json.text }}"
  }
  ```
  `to` peut être un numéro/email brut (`+15551234567`) — le pont le transforme en chat guid `any;-;<to>` — ou un chat guid complet déjà connu (utile pour répondre dans le même fil : réutilise `chatGuid` reçu à l'étape 1 comme `to`).
- Header (si `SEND_AUTH_TOKEN` renseigné dans `.env`) : `x-bridge-token: <votre token>`

## Test rapide

```bash
docker exec photon-imessage-bridge wget -qO- http://localhost:8105/health

# depuis un conteneur sur nexus-network (ex: n8n)
docker exec <conteneur_n8n> wget -qO- --post-data='{"to":"+15551234567","text":"test depuis le pont"}' \
  --header='Content-Type: application/json' http://photon-imessage-bridge:8105/send
```

Envoie ensuite un vrai iMessage à la ligne Photon depuis ton téléphone et regarde les logs :

```bash
docker compose -p photon-to-n8n logs -f imessage-bridge
```

Tu devrais voir `[imessage] gRPC client connected to imessage.spectrum.photon.codes:443 (shared)` au démarrage, puis l'event forwardé vers n8n dès réception.
