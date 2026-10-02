"""Exports orders to CSV. (Fixture: Habi has no Python detector yet.)"""
import csv


def export(rows, path):
    with open(path, "w", newline="") as f:
        csv.writer(f).writerows(rows)
