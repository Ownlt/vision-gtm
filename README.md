# Vision-GTM

Outil de visualisation et d'audit pour un conteneur Google Tag Manager (GTM). Généré à partir d'un export JSON de conteneur, il affiche les tags, déclencheurs, variables et variables intégrées (built-ins) sous forme de carte interactive et de tableaux.

## Dépendances

- **[D3.js](https://d3js.org) v7.9.0** — utilisée pour la carte interactive (graphe de tags/déclencheurs/variables). Vendorisée localement dans `docs/js/vendor/d3.v7.min.js` et chargée via une balise `<script>` classique (pas de gestionnaire de paquets). Voir `docs/index.html`.
