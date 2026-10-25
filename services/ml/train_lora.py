"""Run in a free GPU notebook (not on the small local laptop).

Example: python train_lora.py --input data/support_sft.jsonl --output ./support-lora
Training examples teach response behavior only; never include tenant documents.
"""
import argparse
import json
from datasets import Dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer

BASE_MODEL = "Qwen/Qwen2.5-1.5B-Instruct"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/support_sft.jsonl")
    parser.add_argument("--output", default="./support-lora")
    args = parser.parse_args()
    rows = [json.loads(line) for line in open(args.input, encoding="utf-8") if line.strip()]
    data = Dataset.from_list([{"text": f"<|im_start|>system\nAnswer only from context. Use the user's language and cite with [1], or say HANDOFF.<|im_end|>\n<|im_start|>user\nContext: {r['context']}\nQuestion: {r['question']}<|im_end|>\n<|im_start|>assistant\n{r['answer']}<|im_end|>"} for r in rows])
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, device_map="auto", quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype="bfloat16"))
    trainer = SFTTrainer(model=model, train_dataset=data, processing_class=tokenizer, peft_config=LoraConfig(r=8, lora_alpha=16, lora_dropout=0.05, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"], task_type="CAUSAL_LM"), args=SFTConfig(output_dir=args.output, max_steps=60, per_device_train_batch_size=1, gradient_accumulation_steps=4, learning_rate=2e-4, logging_steps=10, save_steps=30, max_length=1024, report_to="none"))
    trainer.train()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"Adapter saved to {args.output}. Compare with the baseline before serving it.")


if __name__ == "__main__":
    main()
