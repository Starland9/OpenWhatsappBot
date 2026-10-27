const config = require("../config");
const { getLang } = require("../lib/utils/language");
const { Group } = require("../lib/database");

/**
 * Action ou Vérité / Truth or Dare plugin
 * Usage: .av [truth|dare|mode [name]|on|off|help]
 *
 * The questions and dares are French-only content; every message of the bot around them
 * goes through getLang. Group settings live in the Group row (created only when an admin
 * changes them); private chats keep theirs in memory.
 */

const MODES = ["mild", "flirty", "romantic", "adult"];
const ITEMS = {
  mild: {
    truth: [
      "Quel est ton film préféré ?",
      "Quelle est ta pire habitude ?",
      "Quel est ton souvenir d'enfance préféré ?",
      "As-tu déjà menti pour sortir d'un rendez-vous ?",
      "Quelle est ta couleur préférée et pourquoi ?",
      "Quel est ton plat favori que tu pourrais manger tous les jours ?",
      "As-tu un talent caché ? Lequel ?",
      "Quelle a été ta pire expérience scolaire ?",
      "Quelle est ta destination de vacances de rêve ?",
      "Quelle est la chose la plus gentille que quelqu'un t'a faite ?",
      "Quel est ton plus grand rêve professionnel ?",
      "Quel est ton souvenir le plus drôle ?",
      "Quelle est ta chanson préférée et pourquoi ?",
      "Est-ce que tu préfères matin ou soir ? Pourquoi ?",
      "Quelle application utilises-tu le plus sur ton téléphone ?",
      "Quel est ton passe-temps préféré quand tu es seul(e) ?",
      "As-tu déjà fait quelque chose de vraiment spontané ? Raconte.",
      "Quel est ton animal préféré ?",
      "Quelle est ta plus grande fierté personnelle ?",
      "As-tu déjà rencontré quelqu'un de célèbre ? Qui ?",
      "Quelle est la chose la plus drôle que tu aies faite par accident ?",
      "Quel est le pire cadeau que tu aies reçu ?",
      "Si tu pouvais apprendre une nouvelle langue, laquelle choisirais-tu ?",
      "Quel est ton signe astrologique et y crois-tu ?",
      "Quelle est la chose la plus effrayante que tu aies vue ?",
      "Quelle est ta boisson préférée au café ?",
      "As-tu déjà chanté en public ? Raconte l'expérience.",
      "Quelle est ta saison préférée et pourquoi ?",
      "Quel est l'objet le plus précieux pour toi ?",
      "Quelle est ta pire habitude alimentaire ?",
      "Quelle est la chose la plus gentille que tu aies faite pour un inconnu ?",
      "Si tu pouvais changer une chose dans le monde, que changerais-tu ?",
      "Quel est ton jeu vidéo préféré ou ta distraction préférée ?",
      "Quel est ton héros d'enfance ?",
      "Quel est ton péché mignon ?",
      "Quelle est la première chose que tu ferais si tu gagnais à la loterie ?",
      "Quel est le meilleur conseil que tu aies reçu ?",
      "Quelle est la pire habitude d'achat que tu as ?",
      "Quelle est la dernière série que tu as binge-watchée ?",
      "De quoi as-tu le plus peur ?",
      "Quel est ton souvenir d'école le plus mémorable ?",
      "Qui était ton/ta meilleur(e) ami(e) à l'école ?",
      "Quel est ton péché de gourmandise préféré ?",
      "Quel pays veux-tu visiter avant tout ?",
      "As-tu un surnom d'enfance ? Lequel ?",
      "Quelle est la dernière chose qui t'a fait pleurer (émotion sincère) ?",
      "Quel est ton sport ou activité préférée ?",
      "Si tu pouvais dîner avec une personne historique, qui choisirais-tu ?",
      "Quelle est la chose la plus embarrassante que tu aies faite au travail ?",
      "As-tu déjà sauvé un animal ou aidé un animal en détresse ?",
      "Quel est le geste le plus gentil que tu aies fait pour quelqu'un ?",
      "Quelle est la dernière chanson que tu as apprise par cœur ?",
      "Quelle est la chose la plus surprenante que tu aies mangée ?",
      "Quel est ton péché mignon culinaire ?",
      "Quelle est la dernière chose que tu as apprise et que tu trouves utile ?",
      "Quel est le meilleur moment de la journée pour toi ?",
      "Quel est ton magasin préféré pour faire du shopping ?",
      "Quel est ton souvenir le plus artistique ?",
      "Quelle est la chose la plus drôle que tu as vue récemment ?",
      "Quel est ton mot préféré en français ?",
      "Si tu devais choisir un super pouvoir, lequel choisirais-tu ?",
      "Quel est ton dessert préféré ?",
      "Quelle est la première émission que tu regardais enfant ?",
    ],
    dare: [
      "Envoie une photo de ton sourire maintenant (optionnel et seulement si tu le veux).",
      "Fais une blague pendant 30 secondes et envoie-la en message vocal.",
      "Imite une célébrité pendant 20 secondes et envoie une vidéo ou une voix.",
      "Chante le refrain de ta chanson préférée à voix haute et envoie le message vocal.",
      "Envoie un GIF drôle qui te représente en ce moment.",
      "Fais 10 sauts sur place et envoie une petite vidéo.",
      "Envoie une photo de quelque chose que tu aimes dans ta chambre.",
      "Écris ton nom à l'envers dans le chat.",
      "Envoie une blague que tu pourrais dire à un inconnu.",
      "Fais une mini danse de 10 secondes et envoie-la en vidéo.",
      "Partage une anecdote embarrassante rapide.",
      "Prends une photo d'un objet rouge près de toi.",
      "Fais un compliment sincère à quelqu'un dans le chat.",
      "Écris en majuscules ton émission TV préférée pendant 5s, puis supprime le message.",
      "Raconte une blague courte et drôle dans le chat.",
      "Envoie une photo de ton plat préféré (si disponible).",
      "Fais une grimace et envoie-la en photo.",
      "Fais 5 pompes et fais une vidéo rapide.",
      "Improvise un petit sketch de 10 secondes.",
      "Écris un haïku (3 lignes) sur le chat.",
      "Crée un acronyme avec ton prénom et explique-le.",
      "Envoie une photo d'un objet bleu près de toi.",
      "Raconte une anecdote où tu as ri aux larmes.",
      "Envoie un selfie de toi avec un chapeau amusant.",
      "Mime une action pendant 10s et envoie une vidéo.",
      "Fais un compliment anonyme à quelqu'un du groupe.",
      "Envoie le son d'un animal que tu imites.",
      "Fais la voix d'un personnage de dessin animé et envoie-la.",
      "Écris un petit tweet inventé (140 caractères environ) sur un thème aléatoire.",
      "Partage une photo d'une plante chez toi.",
      "Envoie le titre de ton livre préféré.",
      "Fais 20 secondes de respiration profonde et partage ce que tu ressens.",
      "Improvise une chorégraphie de 10 secondes.",
      "Écris une liste de 3 choses que tu aimes aujourd'hui.",
      "Envoie une photo d'un objet qui te rend nostalgique.",
      "Fais une déclaration d'amitié à quelqu'un dans le chat.",
      "Partage la meilleure blague que tu connais.",
      "Imite un bruit de la nature et envoie-le en vocal.",
      "Dis ton premier mot dans une langue étrangère et explique.",
      "Fais le bruit d'une voiture et envoie-le en vocal.",
      "Envoie 3 emojis qui te décrivent ce matin.",
      "Écris un petit compliment aléatoire à la première personne qui répond.",
      "Fais semblant d'être un pirate et envoie un message court.",
      "Dessine quelque chose sur papier et envoie une photo.",
      "Envoie une photo d'un coucher de soleil si tu es près d'une fenêtre.",
      "Dis une phrase d'encouragement sincère à quelqu'un du chat.",
      "Partage ta recette rapide favorite en 1 ligne.",
      "Envoie une photo d'un endroit où tu te sens en paix.",
      "Envoie une courte vidéo où tu dis merci à quelqu'un.",
      "Décris un souvenir heureux en 1 phrase.",
      "Chante une ligne d'une chanson connue (courte).",
      "Imite un animal et fais deviner lequel.",
      "Envoie une photo du ciel de ta fenêtre maintenant.",
      "Dis la première chose que tu ferais si tu gagnais un billet d'avion.",
      "Envoie un emoji qui représente ton humeur aujourd'hui.",
      "Écris une suite de 5 mots qui te font sourire.",
      "Raconte un rêve drôle que tu as fait récemment.",
      "Donne une astuce rapide pour être de bonne humeur.",
      "Écris un petit message inspirant en 1 ligne.",
      "Partage une photo d'un lieu que tu penses visiter un jour.",
    ],
  },
  flirty: {
    truth: [
      "Qu'est-ce que tu trouves le plus attirant chez ton/ta partenaire ?",
      "Quelle a été ta première pensée en voyant ton/ta partenaire aujourd'hui ?",
      "Quelle est ta partie préférée chez ton/ta partenaire ?",
      "Quelle est la chose la plus mignonne que ton/ta partenaire fait pour toi ?",
      "Quel compliment as-tu reçu qui t'a rendu(e) tout(e) chose ?",
      "As-tu déjà envoyé un message secret à ton/ta partenaire ? Raconte sans détails gênants.",
      "Quelle est ta tenue préférée lorsque tu veux impressionner ?",
      "Préférerais-tu un rendez-vous dîner intime ou une sortie aventure ? Pourquoi ?",
      "Quelle est la chanson qui te fait penser à ton/ta partenaire ?",
      "Cite quelque chose que tu aimerais recevoir comme surprise romantique.",
      "As-tu déjà flirté avec quelqu'un en ligne ? Raconte brièvement.",
      "Quelle est ta façon préférée d'exprimer de l'affection ?",
      "Quelle est la chose la plus coquine (light) que tu aies eue l'envie de faire ?",
      "Quelle est ta meilleure technique de drague ?",
      "Quelle est la chose la plus romantique qu'on ait faite pour toi ?",
      "Quelle est la pire façon de draguer, selon toi ?",
      "Quelle est la qualité la plus séduisante chez toi ?",
      "Te sens-tu plus charismatique en soirée ou au calme ?",
      "Quelle est ta boisson pour impressionner lors d'un rendez-vous ?",
      "Raconte le premier rendez-vous le plus mémorable que tu as eu.",
      "Quel compliment te fait instantanément sourire ?",
      "Quelle est ta façon préférée d'initier un flirt ?",
      "As-tu déjà écrit une note secrète à ton/ta partenaire ?",
      "Quelle est ta technique pour briser la glace au premier rendez-vous ?",
      "Quelle est la chose la plus douce qu'on ait faite pour toi ?",
      "As-tu déjà envoyé un message romantique par erreur ? Qu'est-ce qui s'est passé ?",
      "Quelle est la première chose que tu remarques chez quelqu'un qui flirte ?",
      "Quel est ton accessoire préféré pour un rendez-vous ?",
      "Quelle est la meilleure astuce pour demander un second rendez-vous ?",
      "Quelle est ta zone de flirt préférée (yeux, sourire, attitude) ?",
      "As-tu déjà gardé un secret romantique pour quelqu'un ?",
      "Quelle est la pire excuse pour rater un rendez-vous que tu as entendue ?",
      "Quel est l'endroit idéal pour un petit rendez-vous plein de charme ?",
      "Quelle est la phrase d'accroche la plus ringarde que tu connais ?",
      "Préfères-tu écrire un message ou appeler pour flirter ?",
      "Quelle est ta gourmandise romantique : chocolat, fleurs ou autre ?",
      "Quelle est la meilleure manière de complimenter une personne sans paraître lourd ?",
      "As-tu déjà eu un rendez-vous surprise qui a réussi ? Raconte.",
      "Quelle est ta recette pour un rendez-vous réussi ?",
      "Quelle est la petite attention qui te fait fondre ?",
      "Quelle est la meilleure excuse pour prolonger une soirée ensemble ?",
      "Qu'est-ce qui te fait craquer dans un message vocal ?",
      "Quelle est la chose la plus attentionnée que tu aies faite pour impressionner quelqu'un ?",
      "Quelle est ta technique pour écrire un message séduisant ?",
      "As-tu déjà eu un 'crush' inattendu ? Raconte brièvement.",
      "Quelle est la première chose que tu fais après avoir reçu un compliment ?",
      "Quelle est ta façon préférée de finir une conversation charmante ?",
      "Qu'est-ce qui te met mal à l'aise dans le flirting ?",
      "Quelle est ta façon préférée d'envoyer un flirt discret ?",
      "Quelle est une qualité attirante chez une personne que tu aurais négligée avant ?",
      "Quel geste de flirt t'a déconcerté(e) ?",
      "As-tu déjà eu un moment où tu as cru que quelqu'un flirtait avec toi par erreur ?",
      "Quelle est la pire tentative de drague que tu aies entendue ?",
      "As-tu une anecdote amusante de flirt raté ?",
      "Que trouves-tu le plus charmant dans la conversation ?",
      "Quel est le compliment qui t'a mis(e) le plus en valeur ?",
      "Préférerais-tu un flirt subtil ou direct ?",
    ],
    dare: [
      "Envoie un message coquin (mais non explicite) en 10 secondes.",
      "Envoie un bisou en emoji au chat (si tu es d'accord pour le montrer).",
      "Envoie un compliment sincère et très détaillé à ton/ta partenaire.",
      "Envoie un message vocal doux de 10 secondes pour ton/ta partenaire.",
      "Partage une photo (safe) d'un lieu qui te fait penser à ton/ta partenaire.",
      "Envoie la chanson qui te rend le/la plus nostalgique de ton/ta partenaire.",
      "Raconte une petite anecdote où ta timidité a fait sourire ton/ta partenaire.",
      "Donne à ton/ta partenaire un surnom mignon et écris pourquoi.",
      "Envoie un compliment original en 3 mots seulement.",
      "Fais semblant d'écrire une courte lettre d'amour de 1 phrase.",
      "Prends une photo main sur cœur et envoie-la en privé (si tu es à l'aise).",
      "Fais un geste romantique simple dans la pièce et décris-le en 1 phrase.",
      "Envoie un message vocal de 5 secondes où tu dis quelque chose d'admiratif.",
      "Écris la première chose qui te vient à l'esprit sur ton/ta partenaire.",
      "Fais un compliment à la première personne qui répond.",
      "Envoie une photo d'une chose qui te rappelle votre moment préféré.",
      "Envoie une chanson que tu aimerais dédier à quelqu'un.",
      "Envoie 3 emojis qui décrivent ton/ta partenaire.",
      "Dis une blague romantique et fais en sorte que ça fasse sourire.",
      "Écris en une ligne une promesse amusante que tu ferais à ton/ta partenaire.",
      "Fais un petit poème improvisé de 2 lignes.",
      "Décris le rendez-vous parfait en 3 mots.",
      "Chante pendant 10 secondes une chanson romantique et envoie le vocal.",
      "Raconte en 1 phrase un moment intime mais mignon que tu as vécu.",
      "Envoie une photo d'un carnet de notes si tu en as un, avec un mot d'amour.",
      "Fais un compliment original et drôle en 1 phrase.",
      "Écris un acronyme mignon avec les initiales de deux personnes.",
      "Envoie un court vocal où tu dis ton mot romantique préféré.",
      "Fais 3 choses gentilles pour quelqu'un dans la prochaine heure et dis lesquelles.",
      "Prends une courte photo d'un détail que tu aimes chez quelqu'un et partage-la en privé.",
      "Fais un compliment inattendu à un ami dans le chat.",
      "Envoie une photo d'un lieu que tu aimerais visiter en couple.",
      "Chante une chanson d'amour courte en voix haute et envoie-la.",
      "Envoie une photo d'un café près de chez toi.",
      "Partage la note la plus gentille que tu aies reçue.",
      "Écris la description de ton dîner idéal en 1 phrase.",
      "Dis trois qualités qui te rassurent dans une relation.",
      "Conseille un film romantique à regarder pour les prochaines soirées.",
      "Écris une chanson courte (2 lignes) sur 'nous'.",
      "Écris un court slogan romantique pour un t-shirt.",
      "Fais un vocal en souriant et dis une qualité de la personne à côté de toi.",
      "Raconte une anecdote romantique qui te fait sourire sans partager des détails privés.",
      "Dis un secret drôle que tu veux bien partager avec les autres.",
      "Fais sourire quelqu'un en envoyant un mot gentil personnel.",
      "Envoie une photo de ton objet préféré qui te rappelle un moment heureux.",
      "Écris une phrase qui commence par 'Je t'apprécie parce que...'.",
      "Envoie une image qui représente le mot 'amour' pour toi.",
      "Donne un surnom amusant à une personne du chat.",
      "Fais une déclaration rapide de gratitude envers quelqu'un.",
      "Envoie une playlist de 3 chansons romantiques que tu aimes.",
      "Partage un compliment qui mélange humour et affection.",
      "Fais un geste gentil dans la vraie vie et décris-le en 1 phrase.",
      "Envoie un emoji qui représente le rendez-vous parfait pour toi.",
      "Raconte en 1 mot comment tu te sens aujourd'hui à cause de quelqu'un (si applicable).",
    ],
  },
  romantic: {
    truth: [
      "Raconte le moment le plus romantique que tu as vécu.",
      "Quelle est ta plus grande qualité selon toi ?",
      "Que ferais-tu pour surprendre ton/ta partenaire ?",
      "Quelle est la meilleure surprise que tu as faite pour quelqu'un ?",
      "Si tu pouvais écrire une lettre à ton/ta partenaire, que dirais-tu en une phrase ?",
      "Quelle est ta meilleure idée pour un rendez-vous inoubliable ?",
      "Quel est le cadeau le plus attentionné que tu aies reçu ?",
      "Quelle est ta plus belle promesse que tu voudrais tenir ?",
      "Qu'est-ce qui, selon toi, maintient la flamme dans un couple ?",
      "Quels petits gestes te rendent le/la plus heureux(se) au quotidien ?",
      "Si tu devais choisir une destination romantique, laquelle serait-ce ?",
      "Quelle est ta plus douce habitude en couple ?",
      "Quel est le souvenir dont tu voudras encore te rappeler dans 20 ans ?",
      "Quelle est ta plus belle chanson d'amour ?",
      "As-tu déjà fait une déclaration publique d'amour ? Raconte.",
      "Quelle est la meilleure surprise que tu aimerais recevoir ?",
      "Quel est ton geste préféré chez ton/ta partenaire ?",
      "Quelle est la chose la plus romantique que tu aimerais essayer ?",
      "Quels sont tes 3 éléments essentiels pour une soirée romantique ?",
      "Quelle est ta façon préférée de rappeler ton amour au quotidien ?",
      "Quelle est ta plus grande peur en amour ?",
      "Quelle est la chose la plus touchante qu'on t'ait dite ?",
      "Quelle est la plus belle lettre d'amour que tu as reçue (ou écrite) ?",
      "Quel est le petit détail qui te fait fondre chez quelqu'un ?",
      "Que fais-tu pour entretenir la flamme dans une relation ?",
      "Quelle est la chose la plus romantique que tu aies vue au cinéma ?",
      "Quelle est la première chose que tu ferais si ton/ta partenaire avait une mauvaise journée ?",
      "Quelle est la meilleure façon de dire 'je t'aime' selon toi ?",
      "Quel est ton endroit préféré pour un baiser ?",
      "Si tu pouvais revivre un souvenir romantique, quel serait-il ?",
      "Quelle est la règle simple qui maintient une bonne relation selon toi ?",
      "Si tu devais écrire un haïku d'amour, quelle serait la première ligne ?",
      "Quel cadeau simple mais significatif offrirais-tu aujourd'hui ?",
      "Quel est l'objet qui te rappelle le plus ton/ta partenaire ?",
      "As-tu déjà fait quelque chose de spontané et romantique ? Raconte.",
      "Quelle est la chose la plus douce que ton/ta partenaire ait faite pour toi ?",
      "Quel est ton rituel du matin préféré dans la relation ?",
      "As-tu une chanson qui représente votre histoire ? Laquelle ?",
      "Quelle est la petite habitude de ton/ta partenaire que tu adores ?",
      "Quel est le meilleur conseil romantique que tu aies suivi ?",
      "Quelle est la tradition de couple que tu voudrais créer ?",
      "Comment montres-tu ton amour quand tu es timide ?",
      "Quel petit geste te réconforte instantanément ?",
      "Quel est ton souvenir préféré d'un simple moment à deux ?",
      "Quelle est la destination idéale pour une escapade romantique ?",
      "Quelle est l'attention la plus spontanée que tu aies offerte ?",
      "Comment décrirais-tu l'amour en 3 mots ?",
      "As-tu un film romantique préféré ? Pourquoi ?",
      "Quelle est la plus belle chose que tu aies apprise de l'amour ?",
      "Que ferais-tu pour rendre une journée spéciale parfaite ?",
    ],
    dare: [
      "Écris un petit poème de 2 lignes à ton/ta partenaire.",
      "Envoie un message vocal doux de 10 secondes.",
      "Fais une déclaration romantique en 20 secondes.",
      "Envoie une photo (safe) d'un lieu qui te rappelle un beau souvenir.",
      "Fais une liste de 3 choses que tu adores chez ton/ta partenaire.",
      "Envoie une courte vidéo où tu lis un court passage d'une lettre d'amour.",
      "Prépare une mini surprise et décris-la en une phrase.",
      "Crée un petit surnom affectueux et explique pourquoi.",
      "Envoie une photo de quelque chose que ton/ta partenaire t'a offert.",
      "Complimente, en une phrase, la plus belle qualité de ton/ta partenaire.",
      "Décris dans une phrase le moment idéal à deux pour toi.",
      "Écris 3 raisons pour lesquelles tu apprécies ton/ta partenaire.",
      "Envoie une playlist de 5 chansons qui te rappellent un moment spécial.",
      "Envoie une photo d'un repas que tu aimerais partager en tête à tête.",
      "Fais une courte vidéo où tu dis quel est ton meilleur souvenir à deux.",
      "Raconte un souvenir mignon et pourquoi il est spécial.",
      "Écris une phrase qui décrit ton amour en 10 mots.",
      "Envoie une photo d'une carte ou d'un cadeau reçu.",
      "Prépare une petite playlist romantique et partage le lien.",
      "Écris 5 adjectifs qui décrivent la relation idéale selon toi.",
      "Envoie un vocal où tu dis un souvenir heureux ensemble.",
      "Écris un message discret pour surprendre ton/ta partenaire plus tard.",
      "Fais une courte vidéo où tu dis ce que tu admires le plus.",
      "Écris une phrase d'affection en 3 langues différentes.",
      "Envoie une photo d'un lieu où tu te promets d'emmener ton/ta partenaire.",
      "Raconte la première surprise romantique que tu as faite.",
      "Fais une déclaration sincère en 10 mots maximum.",
      "Crée un petit jeu de mots affectueux et envoie-le.",
      "Écris une liste de choses simples qui rendent une journée romantique.",
      "Envoie une photo d'un détail qui symbolise ton amour.",
      "Dis en une phrase pourquoi tu serais prêt(e) à tout pour l'autre.",
      "Fais un geste romantique réel dans la journée et écris ce que c'était.",
      "Choisis un mot romantique qui te touche et explique pourquoi.",
      "Écris une courte lettre d'amour que tu pourrais laisser sur un oreiller.",
      "Raconte en 1 phrase une promesse que tu veux tenir.",
      "Envoie un message vocal où tu chantes maladroitement une phrase romantique.",
      "Écris 3 choses que tu ferais pour surprendre aujourd'hui.",
      "Envoie une photo de tes mains et dis pourquoi tu les aimes.",
      "Écris un haïku romantique de 3 lignes.",
      "Raconte une erreur d'amour qui a débouché sur un moment tendre.",
      "Fais une liste de 5 petites choses qui font une bonne nuit romantique.",
      "Fais une déclaration drôle et mignonne en 1 phrase.",
      "Envoie la première photo de vous deux si tu la retrouves, et partage-la.",
      "Écris 3 petits noms affectueux que tu utiliserais.",
      "Énumère 5 petites attentions qui prouvent l'amour.",
      "Envoie une courte vidéo où tu expliques ton petit rituel romantique.",
      "Donne trois idées de rendez-vous qui ne coûtent pas cher mais qui sont mémorables.",
      "Chante un petit jingle tendre et envoie le message vocal.",
      "Programme une attention pour demain et écris ce que ce sera.",
    ],
  },
  adult: {
    truth: [
      "Quelle est ta plus grande fantaisie (réponds discrètement) ?",
      "As-tu déjà eu un rendez-vous très chaud ? Raconte une anecdote brève (sans détails explicites).",
      "Quelle est la chose la plus attirante que tu as trouvée chez quelqu'un ?",
      "As-tu déjà eu un coup de foudre ? Comment l'as-tu vécu ?",
      "Quelle est la façon préférée d'exprimer ton attirance (baiser, regard, geste, mot) ?",
      "Quelle est ta plus grande surprise romantique qui a touché ton cœur ?",
      "Quel est ton souvenir le plus sensuel (garde-le discret) ?",
      "As-tu déjà été surpris(e) par ton audace romantique ? Raconte brièvement.",
      "Décris une situation qui t'a semblé irrésistiblement attirante (en une phrase).",
      "As-tu déjà eu un compliment intime qui t'a marqué(e) ? Lequel (sans détail) ?",
      "Quelle est la chose la plus séduisante qu'on ait dite sur toi ?",
      "As-tu déjà eu un rendez-vous qui a été plus drôle que prévu ? Raconte une anecdote légère.",
      "Quelle est la première chose que tu remarques chez quelqu'un d'attirant ?",
      "Y a-t-il une odeur qui te rend instantanément attiré(e) ? Laquelle ?",
      "Quelle est la façon la plus romantique de se laisser séduire pour toi ?",
      "As-tu déjà vécu un moment très spécial et suggestif grâce à une chanson ?",
      "Quelle est la qualité la plus sexy chez quelqu'un selon toi ?",
      "Quelle est la chose la plus inattendue qui t'ait attiré(e) chez quelqu'un ?",
      "As-tu déjà surpris quelqu'un avec quelque chose de très tendre et sensuel (discret) ?",
      "Quel est le souvenir le plus sincèrement romantique que tu as partagé ?",
      "As-tu déjà eu des papillons à cause d'un regard ? Raconte en bref.",
      "Quelle est la meilleure manière de flirter sans être explicite ?",
      "As-tu déjà fait un geste spontané de séduction qui a marché ?",
      "Quelle est la petite chose qui te met dans un état d'attirance instantané ?",
      "Quelle est la meilleure façon de garder une tension romantique sans être explicite ?",
      "As-tu déjà été gêné(e) après un compliment romantique ? Raconte.",
      "Quelle est ta façon préférée de dire quelque chose de suggestif sans le dire explicitement ?",
      "As-tu déjà envoyé un message suggestif par accident ? Que s'est-il passé ?",
      "Quelle est la façon la plus subtile d'exprimer un désir (sans être graphique) ?",
      "As-tu déjà eu un rendez-vous qui a changé ta perception de l'attirance ?",
      "Quelle est la meilleure manière d'exprimer de l'attirance sans atteindre l'intimité explicite ?",
      "As-tu déjà ressenti une connexion irrésistible instantanée ? Raconte brièvement.",
      "Quelle est la chose la plus attrayante que tu as entendue dans une conversation intime ?",
      "As-tu déjà été surpris(e) par l'audace d'un compliment ?",
      "Quelle est la meilleure ligne d'accroche que tu aies entendue ?",
      "Quelle est ta limite personnelle quand une relation devient trop suggestive ?",
      "As-tu déjà eu un geste qui a transformé l'attirance en quelque chose de plus profond ?",
      "Quelle est la chose la plus romantique mais discrète que tu aies faite ?",
      "As-tu déjà eu une situation où le flirt est devenu une histoire incroyable ? Raconte brièvement.",
      "Quelle est la meilleure façon de revenir vers quelqu'un après un moment de flirt gênant ?",
      "Quelle est ta première réaction quand quelqu'un te plaît vraiment ?",
      "Quel est le geste le plus inattendu qui t'ait rendu(e) curieux(se) ?",
      "Quelle musique t'inspire à te sentir proche de quelqu'un ?",
      "Quelle est la chose la plus charmante qu'on t'ait dite tard le soir ?",
      "As-tu une habitude secrète qui te rend plus séduisant(e) ?",
      "Décris un moment intime qui t'a marqué (sans détails).",
      "Quelle est ta façon préférée de montrer de l'intérêt en privé ?",
      "Quelle est la petite chose qui peut raviver ton intérêt pour quelqu'un ?",
      "Dis une courte astuce pour un regard significatif.",
      "As-tu déjà écrit une liste de choses à faire en couple ?",
    ],
    dare: [
      "Rien de graphique : envoie un message vocal sur un ton suggestif (court, discret).",
      "Envoie un compliment un peu coquin mais respectueux, en 1 phrase.",
      "Fais un petit clin d'œil emoji et explique pourquoi en 1 phrase.",
      "Envoie un message vocal chuchoté (court et respectueux).",
      "Choisis une chanson sensuelle (non explicite) et partage-la.",
      "Dis en privé à ton/ta partenaire une qualité qui te rend fou/folle.",
      "Décris en une phrase la tenue qui te fait le plus craquer (discret).",
      "Prends une photo safe d'un accessoire romantique et envoie-la en privé.",
      "Lis à voix haute une phrase romantique et envoie le message vocal.",
      "Envoie un vocal où tu susurres une phrase douce (court).",
      "Envoie un compliment qui mélange humour et séduction.",
      "Écris une phrase qui montre ton intérêt sans être explicite.",
      "Fais un compliment sur l'odeur d'une personne (subtil).",
      "Choisis une chanson suggestive mais propre et partage le titre.",
      "Fais un petit geste romantique dans la pièce et décris-le en 1 phrase.",
      "Écris un message de 2 mots qui montre de l'intérêt et envoie-le.",
      "Raconte une anecdote suggestive mais discrète sans entrer dans des détails.",
      "Dis une chose que tu trouves magnétique chez quelqu'un.",
      "Envoie un vocal où tu dis le compliment le plus charmant que tu puisses faire.",
      "Partage une image qui symbolise la passion pour toi (safe).",
      "Écris une phrase courte qui titille la curiosité de ton/ta partenaire.",
      "Envoie un message où tu dis 'tu me rends curieux(se) parce que...' en 1 phrase.",
      "Fais un compliment sur l'allure d'une personne sans décrire le corps.",
      "Fais une petite action (prévue) et décris-la, par ex. apporter un café plus tard.",
      "Envoie une demande de rendez-vous mystérieuse (ex: 'Dispo ce soir ?').",
      "Envoie une image symbolique (bougie/roses) en privé.",
      "Écris une courte phrase d'admiration pour une personne dans le chat.",
      "Fais la lecture d'une phrase sensuelle (soft) et envoie-la en vocal.",
      "Partage une anecdote où la séduction était la source d'un fou rire.",
      "Écris un commentaire charmant sur la façon dont quelqu'un rit.",
      "Envoie un message doux et mystérieux en 3 mots.",
      "Donne une petite 'mise au défi' romantique (ex: préparer une surprise).",
      "Envoie une citation romantique courte qui te touche.",
      "Fais un compliment sur le style vestimentaire sans être trop direct.",
      "Écris une phrase qui commence par 'Tu es...' pour complimenter quelqu'un.",
      "Explique en 1 mot ce que tu trouves le plus séduisant chez quelqu'un.",
      "Envoie un emoji qui décrit ton envie de douceur.",
      "Donne en 1 phrase l'idée d'une surprise qui pourrait faire fondre.",
      "Écris une petite note que tu laisserais sur l'oreiller.",
      "Dis une chose polie mais coquine que tu ferais pour surprendre.",
      "Envoie un petit jeu de mots charmeur et mignon.",
      "Fais une courte vidéo (10s) où tu souris et dis 'tu es génial(e)'.",
      "Envoie en privé une courte liste de 3 détails charmants que tu apprécies chez quelqu'un.",
      "Envoie un message court pour proposer une sortie surprise dans la semaine.",
      "Envoie un compliment sincère et discret à quelqu'un que tu apprécies.",
      "Écris une petite note douce à garder et dis où tu la laisserais (oreiller, livre).",
      "Dis en 1 phrase ce qui te fait fondre dans un sourire.",
    ],
  },
};

const TRUTH_WORDS = ["truth", "t", "v", "verite", "vérité"];
const DARE_WORDS = ["dare", "d", "a", "action"];
const MAX_PM_SETTINGS = 500;

// Private chats have no Group row: chat JID -> { enabled, mode }
const pmSettings = new Map();

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** The chat's settings: group row (defaults: disabled, mild) or the in-memory private ones */
async function loadSettings(message) {
  if (!message.isGroup) {
    return pmSettings.get(message.jid) || { enabled: true, mode: "mild" };
  }
  const group = await Group.findOne({ where: { jid: message.jid } });
  return {
    enabled: !!(group && group.truthDareEnabled),
    mode: group && MODES.includes(group.truthDareMode) ? group.truthDareMode : "mild",
  };
}

/** Save `patch` ({ enabled?, mode? }); a Group row is only created for a group */
async function saveSettings(message, patch) {
  if (!message.isGroup) {
    const next = { ...(await loadSettings(message)), ...patch };
    pmSettings.delete(message.jid);
    pmSettings.set(message.jid, next);
    while (pmSettings.size > MAX_PM_SETTINGS) {
      pmSettings.delete(pmSettings.keys().next().value);
    }
    return;
  }

  const metadata = await message.getGroupMetadata();
  const [group] = await Group.findOrCreate({
    where: { jid: message.jid },
    defaults: { name: metadata?.subject || "" },
  });
  const update = {};
  if (patch.enabled !== undefined) update.truthDareEnabled = patch.enabled;
  if (patch.mode !== undefined) update.truthDareMode = patch.mode;
  await group.update(update);
}

/** Anyone may change the settings of their private chat; in a group, admins and owners */
async function canChangeSettings(message) {
  if (!message.isGroup) return true;
  return message.isSudo() || (await message.isSenderAdmin());
}

function statusText(enabled) {
  return getLang(enabled ? "common.status_enabled" : "common.status_disabled");
}

async function handleMode(message, args) {
  const value = args[1] || "get";

  if (value === "get") {
    const settings = await loadSettings(message);
    return await message.reply(
      getLang("plugins.truthdare.mode_status", settings.mode, statusText(settings.enabled)),
    );
  }

  if (!(await canChangeSettings(message))) {
    return await message.reply(getLang("common.sender_not_admin"));
  }

  if (value === "on" || value === "off") {
    const enabled = value === "on";
    await saveSettings(message, { enabled });
    return await message.reply(getLang("plugins.truthdare.mode_updated", statusText(enabled)));
  }

  if (!MODES.includes(value)) {
    return await message.reply(getLang("plugins.truthdare.mode_invalid", MODES.join("|")));
  }

  await saveSettings(message, { mode: value, enabled: true });
  return await message.reply(getLang("plugins.truthdare.mode_changed", value));
}

module.exports = {
  command: {
    pattern: "av",
    desc: getLang("plugins.truthdare.desc"),
    type: "fun",
  },

  async execute(message, argsString) {
    const args = String(argsString || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const sub = args[0] || "";

    if (sub === "help" || sub === "usage") {
      return await message.reply(getLang("plugins.truthdare.usage", config.PREFIX));
    }

    if (sub === "mode") return await handleMode(message, args);

    if (sub === "on" || sub === "off") {
      if (!(await canChangeSettings(message))) {
        return await message.reply(getLang("common.sender_not_admin"));
      }
      const enabled = sub === "on";
      await saveSettings(message, { enabled });
      return await message.reply(getLang("plugins.truthdare.mode_updated", statusText(enabled)));
    }

    let kind;
    if (TRUTH_WORDS.includes(sub)) kind = "truth";
    else if (DARE_WORDS.includes(sub)) kind = "dare";
    else if (sub === "" || sub === "random") kind = Math.random() > 0.5 ? "truth" : "dare";
    else return await message.reply(getLang("plugins.truthdare.usage", config.PREFIX));

    const settings = await loadSettings(message);
    if (!settings.enabled) {
      return await message.reply(getLang("plugins.truthdare.disabled", config.PREFIX));
    }

    const item = randomItem(ITEMS[settings.mode][kind]);
    return await message.reply(
      getLang(kind === "truth" ? "plugins.truthdare.card_truth" : "plugins.truthdare.card_dare", item),
    );
  },
};
