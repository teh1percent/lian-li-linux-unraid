'use strict';

// Loaded last, so every page script is in place before the first draw.
document.getElementById('logo').innerHTML = icon('fans');
renderTabs();
refresh(true);
setInterval(refresh, 4000);
