#!/bin/bash
rm -rf .git
git init
git add Anchor.toml Cargo.toml package.json tsconfig.json .gitignore .prettierignore migrations/
git commit -m "initial anchor scaffolding"
git add programs/
git commit -m "wrote the escrow smart contract logic"
git add tests/
git commit -m "added typescript tests for the instructions"
git add README.md tests-screenshot*.png
git commit -m "added readme and screenshots of passing tests"
git add .
git commit -m "final project locks and configs"
git branch -M main
git remote add origin https://github.com/SAMIR897/week3-assignment_escrow.git
git push -f -u origin main
