#!/bin/bash
# Mygration deploy - pull latest static files
cd /root/mygration && git pull origin main
echo "Mygration frontend updated."
