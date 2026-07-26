# photon-to-n8n

Pont Docker entre [Photon iMessage](https://photon.codes/platform/imessage) et n8n.

Le conteneur expose **deux routes sur deux ports différents** (même process Express, deux `http.Server`) :

| Sens | Port | Route | Qui appelle qui |
|---|---|---|---|
| Photon → pont | `WEBHOOK_PORT` (8106) | `POST /webhook/photon` | Photon appelle le pont quand un iMessage arrive → le pont relaie vers `N8N_WEBHOOK_URL` |
| n8n → pont | `SEND_PORT` (8105) | `POST /send` | n8n appelle le pont pour envoyer un iMessage sortant → le pont appelle l'API Photon |

Cette séparation en deux ports est volontaire : `8105` (envoi) n'a besoin d'être joignable que depuis n8n (local, ou réseau Docker interne), alors que `8106` (réception) doit être joignable depuis internet puisque c'est Photon qui vous contacte.

## ⚠️ À vérifier avant de démarrer

Je n'ai pas pu récupérer automatiquement la doc `docs.photon.codes` (bloquée en 403 côté serveur pour les fetchs automatisés). Le code ne fige donc pas en dur l'URL/le format exact de l'API Photon pour l'envoi de message ni le nom de l'en-tête de signature du webhook — tout est en variables d'environnement (`.env`) pour que vous puissiez coller les vraies valeurs trouvées dans votre dashboard `app.photon.codes` / la doc, sans toucher au code :

- `PHOTON_SEND_URL`, `PHOTON_AUTH_HEADER`, `PHOTON_AUTH_SCHEME` → format d'appel pour envoyer un message
- `PHOTON_SIGNATURE_HEADER`, `PHOTON_WEBHOOK_SECRET` → vérification de signature du webhook entrant (désactivée si `PHOTON_WEBHOOK_SECRET` est vide)

À noter aussi : Photon fournit un **node communautaire n8n officiel** (`n8n-nodes-imessage`, https://github.com/photon-hq/n8n-nodes-imessage) qui fait exactement ce pont nativement (trigger + envoi), sans conteneur custom. Le présent pont reste utile si vous voulez garder le contrôle total du flux ou si l'install de community nodes n'est pas possible sur votre instance n8n — mais si ni l'un ni l'autre ne s'applique, ce node officiel vous évite de maintenir ce code.

## Installation

```bash
cp .env.example .env
# éditez .env : PHOTON_PROJECT_ID, PHOTON_API_KEY, PHOTON_SEND_URL, N8N_WEBHOOK_URL...

docker compose up -d --build
```

## Configuration côté Photon

Dans `app.photon.codes` → votre projet → Webhooks, réglez l'URL de webhook entrant sur l'adresse publique du serveur, port 8106 :

```
https://n8n1.voituredujour.duckdns.org:8106/webhook/photon
```

(scénario "même serveur que n8n" : on réutilise le même nom de domaine duckdns, juste un port différent, ouvert sur le pare-feu/la box vers le conteneur). Le jour où le pont ne sera plus sur le même serveur que n8n, seule cette URL de webhook Photon et la valeur de `N8N_WEBHOOK_URL` dans `.env` changent — le reste ne bouge pas.

## Configuration côté n8n

### 1. Recevoir les messages entrants — node **Webhook** (trigger)

- Node : `Webhook`
- HTTP Method : `POST`
- Path : `photon` (correspond à `https://n8n1.voituredujour.duckdns.org/webhook/photon`, l'URL que vous avez déjà)
- Respond : `Immediately` (le pont n'attend pas de réponse particulière de n8n)

Le body reçu est le payload brut renvoyé par Photon (tel que relayé par `/webhook/photon` du pont).

### 2. Envoyer un message — node **HTTP Request**

- Node : `HTTP Request`
- Method : `POST`
- URL : `http://localhost:8105/send` (même serveur ; si n8n tourne lui aussi dans Docker, utilisez plutôt `http://photon-imessage-bridge:8105/send` en les mettant sur le même réseau Docker)
- Body Content Type : `JSON`
- Body :
  ```json
  {
    "to": "={{ $json.to }}",
    "text": "={{ $json.text }}"
  }
  ```
- Header (si `SEND_AUTH_TOKEN` renseigné dans `.env`) : `x-bridge-token: <votre token>`

Astuce : mettez l'URL de base (`http://localhost:8105`) dans une variable d'environnement n8n (`BRIDGE_URL`) plutôt qu'en dur dans le node, pour n'avoir qu'un seul endroit à changer le jour où le pont ne sera plus local.

## Test rapide

```bash
curl http://localhost:8105/health

curl -X POST http://localhost:8105/send \
  -H 'Content-Type: application/json' \
  -d '{"to":"+15551234567","text":"test depuis le pont"}'
```
