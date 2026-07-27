# photon-to-n8n

Pont Docker entre [Photon iMessage](https://photon.codes/platform/imessage) et n8n.

Le conteneur expose **deux routes sur deux ports différents** (même process Express, deux `http.Server`) :

| Sens | Port | Route | Qui appelle qui |
|---|---|---|---|
| Photon → pont | `WEBHOOK_PORT` (8106) | `POST /webhook/photon` | Photon appelle le pont quand un iMessage arrive → le pont relaie vers `N8N_WEBHOOK_URL` |
| n8n → pont | `SEND_PORT` (8105) | `POST /send` | n8n appelle le pont pour envoyer un iMessage sortant → le pont appelle l'API Photon |

**Aucun des deux ports n'est publié sur l'hôte.** n8n et Nginx Proxy Manager (NPM) tournant chacun dans leur propre conteneur sur le même serveur, le pont rejoint le réseau Docker déjà partagé par les deux (`nexus-network`) et est appelé par les autres conteneurs via son **nom de conteneur**, pas via une IP ou un port exposé sur l'hôte/LAN. C'est ce qui manquait la première fois (`ECONNREFUSED 192.168.2.32:8105` = rien n'écoutait sur l'IP LAN, seulement sur `127.0.0.1` de l'hôte).

## ⚠️ À vérifier avant de démarrer

Je n'ai pas pu récupérer automatiquement la doc `docs.photon.codes` (bloquée en 403 côté serveur pour les fetchs automatisés). Le code ne fige donc pas en dur l'URL/le format exact de l'API Photon pour l'envoi de message ni le nom de l'en-tête de signature du webhook — tout est en variables d'environnement (`.env`) pour que vous puissiez coller les vraies valeurs trouvées dans votre dashboard `app.photon.codes` / la doc, sans toucher au code :

- `PHOTON_SEND_URL`, `PHOTON_AUTH_HEADER`, `PHOTON_AUTH_SCHEME` → format d'appel pour envoyer un message
- `PHOTON_SIGNATURE_HEADER`, `PHOTON_WEBHOOK_SECRET` → vérification de signature du webhook entrant (désactivée si `PHOTON_WEBHOOK_SECRET` est vide, ce qui est correct pour tester)

À noter aussi : Photon fournit un **node communautaire n8n officiel** (`n8n-nodes-imessage`, https://github.com/photon-hq/n8n-nodes-imessage) qui fait exactement ce pont nativement (trigger + envoi), sans conteneur custom.

## Installation

```bash
cp .env.example .env
# éditez .env : PHOTON_PROJECT_ID, PHOTON_API_KEY, PHOTON_SEND_URL, N8N_WEBHOOK_URL...

docker compose up -d --build
```

## Brancher le pont sur le réseau nexus-network

`docker-compose.yml` déclare `nexus-network` comme réseau **externe** (`external: true`) et y attache directement le pont au démarrage — comme n8n et NPM y sont déjà, il n'y a rien d'autre à faire, pas de `docker network connect` manuel.

Vérifiez que ça communique :

```bash
docker exec <conteneur_n8n> wget -qO- http://photon-imessage-bridge:8105/health
```

(si `wget` n'est pas installé dans l'image n8n, utilisez `curl` à la place, ou testez directement depuis le node HTTP Request dans n8n)

## Configuration côté Photon

Dans `app.photon.codes` → votre projet → Webhooks, réglez l'URL de webhook entrant sur le domaine HTTPS que NPM gère déjà pour n8n, avec le chemin `/webhook/photon` :

```
https://n8n1.voituredujour.duckdns.org/webhook/photon
```

Pas de port custom, pas de nouveau sous-domaine, pas de nouveau certificat — on réutilise le 443/TLS déjà en place.

### Configurer la route dans Nginx Proxy Manager

Dans NPM, éditez le **Proxy Host** existant pour `n8n1.voituredujour.duckdns.org`, onglet **Custom Locations**, ajoutez :

- Location : `/webhook/photon`
- Scheme : `http`
- Forward Hostname/IP : `photon-imessage-bridge`
- Forward Port : `8106`

Sauvegardez, puis testez :

```bash
curl -i https://n8n1.voituredujour.duckdns.org/webhook/photon -X POST -H 'Content-Type: application/json' -d '{"test":true}'
```

Vous devriez voir `{"received":true}` et une nouvelle ligne dans `docker compose logs imessage-bridge` (au lieu du 401 si `PHOTON_WEBHOOK_SECRET` est rempli et que la signature ne correspond pas — normal avec ce curl de test).

## Configuration côté n8n

### 1. Recevoir les messages entrants — node **Webhook** (trigger)

- Node : `Webhook`
- HTTP Method : `POST`
- Path : `photon` (correspond à `https://n8n1.voituredujour.duckdns.org/webhook/photon`, l'URL que vous avez déjà)
- Respond : `Immediately`

Le body reçu est le payload brut renvoyé par Photon (tel que relayé par `/webhook/photon` du pont).

### 2. Envoyer un message — node **HTTP Request**

- Node : `HTTP Request`
- Method : `POST`
- URL : `http://photon-imessage-bridge:8105/send` (nom du conteneur, pas une IP — fonctionne car n8n et le pont sont sur `nexus-network`)
- Body Content Type : `JSON`
- Body :
  ```json
  {
    "to": "={{ $json.to }}",
    "text": "={{ $json.text }}"
  }
  ```
- Header (si `SEND_AUTH_TOKEN` renseigné dans `.env`) : `x-bridge-token: <votre token>`

Astuce : mettez l'URL de base (`http://photon-imessage-bridge:8105`) dans une variable d'environnement n8n (`BRIDGE_URL`) plutôt qu'en dur dans le node, pour n'avoir qu'un seul endroit à changer le jour où le pont ne sera plus sur le même serveur/réseau.

## Test rapide

```bash
# depuis le serveur (n'importe quel conteneur du réseau nexus-network)
docker exec photon-imessage-bridge wget -qO- http://localhost:8105/health

docker exec <conteneur_n8n> wget -qO- --post-data='{"to":"+15551234567","text":"test depuis le pont"}' \
  --header='Content-Type: application/json' http://photon-imessage-bridge:8105/send
```
