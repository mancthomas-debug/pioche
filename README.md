# Pioche

Liste perso de films, séries, livres, spectacles, musique, podcasts, expos et lieux à découvrir.
PWA statique, sans backend ni build : `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.json`, `icons/`.

## Tester en local
```
python -m http.server 8642
```
puis http://localhost:8642

## Mettre en ligne (GitHub Pages, gratuit)
1. Créer un dépôt GitHub et y pousser ces fichiers.
2. Settings → Pages → « Deploy from a branch » → `main` / racine.
3. Sur l'iPhone, ouvrir l'URL dans Safari → Partager → « Sur l'écran d'accueil ».

## Premier lancement
- ⚙︎ Réglages → coller la clé TMDB (themoviedb.org → Paramètres → API, gratuit). Stockée seulement sur le téléphone.
- Exporter régulièrement la liste (Réglages → Exporter) : iOS peut purger les données d'un site.

## Sources
TMDB (films/séries + plateformes FR), catalogue BnF + Google Books si clé saisie → repli Open Library (livres), iTunes Search (musique, podcasts ; repli JSONP si CORS bloque).

## Raccourci iOS (bonus V2)
L'appli accepte déjà `?add=<titre ou url>` : un Raccourci peut ouvrir `https://<votre-site>/?add=…` pour pré-remplir l'ajout.
Après une mise à jour des fichiers, incrémenter `VERSION` dans `sw.js`.
