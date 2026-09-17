"""Local multilingual embedding worker. Only game knowledge/questions enter this process."""
import json, sys, os
from pathlib import Path
os.environ['HF_HOME']=str(Path(__file__).resolve().parents[1]/'.models')
os.environ['HF_HUB_DISABLE_XET']='1'
from sentence_transformers import SentenceTransformer
import numpy as np
MODEL='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
model=SentenceTransformer(MODEL,device='cpu',trust_remote_code=False)
cards=json.loads(Path('knowledge/semantic-corpus.json').read_text())
vectors=model.encode([c['title']+'。'+c['principle']+' 注意：'+c['counterexample'] for c in cards],normalize_embeddings=True,show_progress_bar=False)
print(json.dumps({'ready':True,'model':MODEL,'cards':len(cards)}),flush=True)
for line in sys.stdin:
 try:
  req=json.loads(line);q=str(req['query'])[:180];vec=model.encode([q],normalize_embeddings=True,show_progress_bar=False)[0]
  scores=vectors@vec
  hits=[{'id':cards[int(i)]['id'],'score':float(scores[i])} for i in np.argsort(-scores) if cards[int(i)]['rulesVersion']==req.get('rulesVersion','0.6')][:10]
  print(json.dumps({'id':req.get('id'),'hits':hits,'model':MODEL}),flush=True)
 except Exception:
  print(json.dumps({'id':req.get('id'),'error':'semantic-worker-failed'}),flush=True)
