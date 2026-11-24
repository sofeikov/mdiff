from pathlib import Path

import pandas as pd


def load() -> pd.DataFrame:
    return pd.read_csv(Path(__file__).parent.parent / "data" / "scores.csv")
