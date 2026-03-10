import csv
import pandas as pd
from pathlib import Path

csv_path = Path("results/test/test_contracts.csv")
excel_path = Path("results/test/test_contracts.xlsx")

print("--- CSV CONTENT ---")
with open(csv_path, encoding='utf-8-sig') as f:
    reader = csv.reader(f)
    for row in reader:
        print(row)

print("\n--- EXCEL CONTENT ---")
df = pd.read_excel(excel_path)
print("Headers:", list(df.columns))
print("Row 0:", df.iloc[0].to_dict())
print("Row 1:", df.iloc[1].to_dict())
