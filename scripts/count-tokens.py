import sys,json
from pathlib import Path
from tokenizers import Tokenizer
from jinja2.sandbox import SandboxedEnvironment
root=Path(__file__).resolve().parents[1]/'.models/deepseek-v4-tokenizer'
config=json.loads((root/'tokenizer_config.json').read_text())
tokenizer=Tokenizer.from_file(str(root/'tokenizer.json'))
request=json.load(sys.stdin)
template=SandboxedEnvironment().from_string(config['chat_template'])
rendered=template.render(messages=request['messages'],bos_token=config['bos_token']['content'],eos_token=config['eos_token']['content'],add_generation_prompt=True)
print(json.dumps({'tokens':len(tokenizer.encode(rendered,add_special_tokens=False).ids),'tokenizer':'DeepSeek official V4','includes':'chat template, system, user, history and serialized tool contracts/receipts'}))
