// ---------- Novità ----------
// Newest first. Add an entry at every update: it pops up once on each device, then stays under "Novità".
const NEWS = [
  { v: '1.13', date: '23 ottobre 2026', title: 'Tema chiaro o scuro e guide passo passo', items: [
    ['ph-circle-half', 'Scegli tu il tema: Auto segue il telefono, oppure Chiaro o Scuro. Il selettore è in fondo al menu (su telefono in "Altro") e in fondo alla pagina di prenotazione. La scelta resta su quel dispositivo.'],
    ['ph-book-open', 'In Impostazioni, accanto a SMS automatici e Notifiche sul telefono, trovi "Guida passo passo": spiega cosa toccare su Android, iPhone e computer e cosa fare se qualcosa non va.'],
  ] },
  { v: '1.12', date: '23 ottobre 2026', title: 'SMS automatici e notifiche sul telefono', items: [
    ['ph-chat-text', "Le clienti ricevono un SMS di conferma appena prendi l'appuntamento (anche online) e un promemoria il giorno prima. Partono dal telefono del salone con la sua SIM: si attivano in Impostazioni."],
    ['ph-bell-ringing', 'Il telefono ti avvisa delle nuove prenotazioni online anche con l\'app chiusa, e ogni mattina ti manda il riepilogo della giornata. Attivale in Impostazioni su ogni telefono.'],
    ['ph-list-checks', 'In Impostazioni vedi gli ultimi SMS: inviati, in attesa o non partiti, con il motivo. In agenda il badge "SMS" segna le clienti già avvisate.'],
  ] },
  { v: '1.11', date: '19 ottobre 2026', title: 'Import più furbo e registro più chiaro', items: [
    ['ph-file-csv', "L'import CSV esclude le persone senza numero di telefono e aggiorna le clienti già in archivio invece di saltarle. Due persone con lo stesso numero ma nomi diversi (mamma e figlia) restano due schede."],
    ['ph-calendar-plus', "Dopo la prenotazione online la cliente aggiunge l'appuntamento al calendario: Google Calendar, Apple su iPhone, Samsung o altro su Android, file da scaricare su computer. Il calendario la avvisa 2 ore prima."],
    ['ph-bug', 'Il registro errori dice in parole semplici cosa è successo (rete, server, accesso) e registra anche quando manca la connessione.'],
  ] },
  { v: '1.10', date: '19 ottobre 2026', title: 'Clienti in blocco e registro errori', items: [
    ['ph-file-csv', "In Schede clienti puoi importare ed esportare le clienti in CSV (si apre con Excel). All'import le clienti già presenti vengono saltate."],
    ['ph-check-square', 'Seleziona più clienti con le caselle, o tutte insieme, ed eliminale in un colpo solo.'],
    ['ph-phone-x', 'Il filtro "Senza telefono" mostra le clienti senza numero: selezionale tutte e fai pulizia.'],
    ['ph-bug', 'In Impostazioni il "Registro errori" mostra gli ultimi problemi di questo dispositivo, da copiare e inviare a chi ti assiste.'],
  ] },
  { v: '1.9', date: '19 ottobre 2026', title: 'Gli appuntamenti nel calendario del telefono', items: [
    ['ph-calendar-check', 'Dopo aver prenotato online, la cliente tocca "Aggiungi al calendario": su iPhone si apre il Calendario, su Android Google Calendar, con giorno, ora, servizi e indirizzo già scritti.'],
    ['ph-calendar-plus', 'In Impostazioni trovi "Calendario del telefono": aggiungi il link a Google Calendar e gli appuntamenti compaiono da soli nel calendario di Android.'],
    ['ph-clock', 'Google aggiorna il calendario ogni qualche ora: per le prenotazioni appena arrivate fa fede il gestionale, con il suo bip.'],
  ] },
  { v: '1.8', date: '16 ottobre 2026', title: 'Il riepilogo della giornata', items: [
    ['ph-sun', "In cima all'agenda trovi il saluto e il riepilogo di oggi: quanti appuntamenti, quanti già fatti e l'incasso. I riquadri con i numeri compaiono quando guardi un altro giorno, la settimana o il mese."],
    ['ph-clock', "Vedi subito chi arriva dopo e tra quanto, o chi è in poltrona adesso: tocca il nome per aprire la sua scheda."],
    ['ph-package', 'Con un tocco vai alle clienti da richiamare o ai prodotti da riordinare. I promemoria non mostrano più gli appuntamenti già passati.'],
  ] },
  { v: '1.7', date: '16 ottobre 2026', title: 'Le prenotazioni online arrivano da sole', items: [
    ['ph-bell-ringing', 'Con il gestionale aperto, una nuova prenotazione dalla pagina web arriva entro 20 secondi con un bip e un avviso in alto: tocca "Vedi" per aprire quel giorno in agenda.'],
    ['ph-wifi-high', 'Se il dispositivo era in standby, l\'avviso compare appena riapri l\'app.'],
    ['ph-sparkle', 'Accanto a Novità ora vedi la versione dell\'app che stai usando.'],
  ] },
  { v: '1.6', date: '16 ottobre 2026', title: 'Scheda cliente, foto e richiami', items: [
    ['ph-identification-card', 'Tocca il nome di una cliente (anche in agenda) per aprire la sua scheda: dati, formula, note, quanto ha speso e lo storico delle visite.'],
    ['ph-camera-plus', 'Allega foto alla scheda (prima e dopo, colore): vengono ridotte a 480p sul dispositivo, quindi occupano pochissimo. Le foto non sono incluse nel file di backup.'],
    ['ph-clock-counter-clockwise', 'In Schede clienti la lista "Da richiamare" mostra chi non viene da qualche settimana e non ha appuntamenti: un tocco e le scrivi su WhatsApp.'],
    ['ph-coffee', 'In Impostazioni imposta pausa pranzo, ferie e festivi: la pagina di prenotazione li blocca da sola e l\'agenda li mostra.'],
  ] },
  { v: '1.5', date: '16 ottobre 2026', title: 'Ogni sezione ha il suo indirizzo', items: [
    ['ph-link', 'Agenda, clienti, listino e le altre sezioni hanno un indirizzo proprio (es. /clienti): aggiornando la pagina resti dove sei, Indietro funziona e puoi salvarle nei preferiti.'],
    ['ph-lock-simple', "All'apertura il gestionale resta nascosto finché l'accesso non è verificato."],
    ['ph-lifebuoy', 'Se su Vercel mancano il database o la password, una schermata spiega passo passo come sistemare.'],
  ] },
  { v: '1.4', date: '16 ottobre 2026', title: 'Configurazione guidata', items: [
    ['ph-magic-wand', 'Alla prima installazione una configurazione guidata ti accompagna passo passo: dati del salone, orari, listino e link per le clienti.'],
    ['ph-gear-six', 'Puoi riaprirla quando vuoi da Impostazioni, con il pulsante "Configurazione guidata".'],
  ] },
  { v: '1.3', date: '16 ottobre 2026', title: 'Funziona anche senza internet', items: [
    ['ph-wifi-slash', "Senza rete il gestionale si apre lo stesso: vedi gli ultimi dati scaricati e puoi aggiungere o modificare appuntamenti."],
    ['ph-cloud-arrow-up', "Le modifiche fatte offline restano sul dispositivo e partono da sole quando torna la rete. Una barra in alto ti dice quante ne mancano."],
    ['ph-warning-octagon', "Se un appuntamento inserito offline si sovrappone a un altro, per esempio a una prenotazione web arrivata nel frattempo, te lo segnalo e lo vedi evidenziato in agenda."],
    ['ph-device-mobile', "Per usarlo offline in sicurezza installa l'app sulla schermata Home e fai l'accesso almeno una volta con la rete."],
  ] },
  { v: '1.2', date: '16 ottobre 2026', title: 'Agenda a settimana e mese, promemoria e listino a cartelle', items: [
    ['ph-calendar-blank', 'Agenda in vista Giorno, Settimana o Mese, con appuntamenti e incasso del periodo. Tocca un giorno per aprirlo.'],
    ['ph-bell-ringing', 'Promemoria in cima all’agenda: le clienti di oggi, domani e dopodomani da avvisare, con WhatsApp, SMS e "Avvisata".'],
    ['ph-megaphone', 'Avvisa o scrivi a una cliente quando vuoi, con un messaggio che puoi modificare, dall’agenda o dalla sua scheda.'],
    ['ph-folder', 'Listino a cartelle (es. PIEGA, TAGLIO): crea, rinomina ed elimina le cartelle, aprile e chiudile con un tocco.'],
    ['ph-pencil-simple', 'Ora puoi modificare nome, cartella, prezzo e durata di ogni servizio.'],
    ['ph-globe-simple', 'Anche la pagina di prenotazione mostra i servizi divisi per cartelle.'],
  ] },
  { v: '1.1', date: '16 ottobre 2026', title: 'Più sicurezza e app installabile', items: [
    ['ph-download-simple', "Installa Salone PRO sulla schermata Home di tablet, telefono e computer: usa il banner in basso o la guida in Impostazioni."],
    ['ph-lock-simple', "Dopo 5 password sbagliate l'accesso da quel dispositivo si blocca per 15 minuti."],
    ['ph-devices', 'Hai perso un tablet? In Impostazioni usa "Esci da tutti i dispositivi" per scollegarlo subito.'],
    ['ph-shield-check', "Prenotazioni online protette dai bot: massimo 10 tentativi all'ora per dispositivo."],
    ['ph-whatsapp-logo', 'Il link di prenotazione condiviso su WhatsApp ora mostra immagine e descrizione.'],
  ] },
  { v: '1.0', date: '16 ottobre 2026', title: 'Salone PRO è online', items: [
    ['ph-cloud-check', 'I dati sono nel database online: li vedi da qualsiasi dispositivo, non solo dal tablet.'],
    ['ph-globe-simple', "Le clienti prenotano da sole su /prenota e l'appuntamento arriva subito in agenda con il badge Web."],
    ['ph-clock', 'Gli orari occupati tengono conto della durata dei servizi, niente più sovrapposizioni.'],
    ['ph-calendar-blank', 'Giorni di chiusura e intervallo degli orari online si impostano in Impostazioni.'],
    ['ph-device-mobile', 'Funziona su computer, tablet e telefono, con tema scuro automatico.'],
  ] },
];

function newsSeen() {
  try { return localStorage.getItem('sp_news'); } catch { return null; }
}

function openNews() {
  $('news-list').innerHTML = NEWS.map((n, i) => `
    <section class="news-ver">
      <header>
        <h3>${n.title}</h3>
        ${i ? '' : '<span class="badge badge-accent">Nuovo</span>'}
        <span class="muted small">Versione ${n.v}, ${n.date}</span>
      </header>
      <ul>${n.items.map(([icon, text]) => `<li><i class="ph ${icon}" aria-hidden="true"></i><span>${text}</span></li>`).join('')}</ul>
    </section>`).join('');
  closeModal('more-sheet');
  openModal('news-modal');
  try { localStorage.setItem('sp_news', NEWS[0].v); } catch {}
}

document.querySelectorAll('.app-ver').forEach((e) => { e.textContent = 'v' + NEWS[0].v; });

actions.click.openNews = openNews;
