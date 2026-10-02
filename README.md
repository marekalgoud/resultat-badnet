# resultat-badnet

## Scraping hebdomadaire

GitHub Actions lance `npm run scrape:rhone` chaque lundi à 06:00 UTC, soit 07:00 ou 08:00 en France selon l'heure d'hiver ou d'été. Le workflow peut aussi être lancé manuellement depuis l'onglet **Actions**.

Pour recevoir le résultat sur Discord :

1. Crée un webhook dans les paramètres du salon Discord où tu veux recevoir les notifications.
2. Dans le dépôt GitHub, ouvre **Settings > Secrets and variables > Actions**.
3. Ajoute un secret nommé `DISCORD_WEBHOOK_URL` contenant l'URL du webhook.

La notification indique si le scraping a réussi et contient un lien vers les logs de l'exécution. Le workflow échoue également si l'extraction d'au moins un tournoi échoue.
