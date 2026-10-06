# Mormors Kokbok

A family cookbook you can open in a browser and share on the home network. The pages are in Swedish.

## Start

```bash
python3 server.py
```

Open http://localhost:8080

The published book, for anyone with the link, is https://naelsh.github.io/mormors_lilla_roda/ once GitHub Pages has finished the first deploy. That copy is for reading. New recipes are added here, then published with `git push`.

The terminal also prints an address for other phones and computers on the same Wi-Fi. The computer running the server needs to stay on.

If a phone on the same Wi-Fi cannot connect, the firewall may be blocking the port:

```bash
sudo firewall-cmd --add-port=8080/tcp
```

Use another port with `PORT=9000 python3 server.py`.

## Using it

- Browse, search, and open a recipe.
- Change the number of portions and the ingredient amounts follow.
- Heart a recipe to keep it under Sparade in that browser.
- Add or change a recipe with Nytt recept, from http://localhost:8080 on this computer. That asks for the editor password.
- Anyone else can read the book. Phones on the Wi-Fi, and the published site, cannot change recipes.

The password is the first line of `data/password`, or the environment variable `COOKBOOK_PASSWORD` if that is set. The password file is not part of the published book. Change it before you put the site online, then restart the server.

## Where things are saved

- `data/recipes.json` — the recipes
- `public/images` — the photos that came with the book
- `public/uploads` — photos the family adds

The starter photos are from Wikimedia Commons. Each recipe page names the photographer and the license.
