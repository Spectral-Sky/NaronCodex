/* NFT image fallback, shared by the pages that show IPFS art.
   Card art lives on IPFS. The public ipfs.io gateway started refusing requests
   (HTTP 429, Nov 2026), which broke every image routed through it, so pages now
   use Alien Worlds' own gateway. If an image still fails, this walks it through
   other sources for the same hash: the resizer on Alien Worlds' gateway, then
   AtomicHub's resizer, then the gateway directly, then Pinata. It listens in the
   capture phase so it runs before a page's own onerror, which it then stands in for. */
(function () {
    var HASH = /(?:\/ipfs\/|[?&]ipfs=)(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{50,})/;
    var CHAIN = [
        function (h, w) { return 'https://wsrv.nl/?url=ipfs.alienworlds.io/ipfs/' + h + '&w=' + w + '&output=webp'; },
        function (h, w) { return 'https://resizer.atomichub.io/images/v1/preview?ipfs=' + h + '&size=' + (w > 200 ? 370 : 200); },
        function (h) { return 'https://ipfs.alienworlds.io/ipfs/' + h; },
        function (h) { return 'https://gateway.pinata.cloud/ipfs/' + h; }
    ];
    window.addEventListener('error', function (e) {
        var img = e.target;
        if (!img || img.tagName !== 'IMG') return;
        var src = '';
        try { src = decodeURIComponent(img.currentSrc || img.src || ''); } catch (x) { src = img.src || ''; }
        var m = HASH.exec(src);
        if (!m) return;
        var step = Number(img.getAttribute('data-ipfs-step') || 0);
        if (step >= CHAIN.length) return;          // every source tried: let the page's own handler decide
        var w = Number((/[?&](?:w|width|size)=(\d+)/.exec(src) || [])[1]) || 240;
        var next = CHAIN[step](m[1], w);
        img.setAttribute('data-ipfs-step', step + 1);
        if (next === src) { next = CHAIN[step + 1] ? CHAIN[step + 1](m[1], w) : null; img.setAttribute('data-ipfs-step', step + 2); }
        if (!next) return;
        img.onerror = null;
        img.style.display = '';
        img.src = next;
    }, true);
})();
