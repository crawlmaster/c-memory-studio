import asyncio
import json
import websockets

C_CODE = r"""#include <stdlib.h>

struct Node {
    int val;
    struct Node *next;
};

void bubble_pass(int *arr, int n) {
    for (int i = 0; i < n - 1; i++) {
        int j = i + 1;
        if (arr[i] > arr[j]) {
            int tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
    }
}

int main(void) {
    int n = 4;
    int *arr = malloc(n * sizeof(int));
    arr[0] = 8; arr[1] = 2; arr[2] = 5; arr[3] = 1;

    struct Node *head = malloc(sizeof(struct Node));
    struct Node *second = malloc(sizeof(struct Node));
    head->val = 10;
    head->next = second;
    second->val = 20;
    second->next = NULL;

    struct Node *curr = head;
    bubble_pass(arr, n);

    free(second);
    free(head);
    free(arr);
    return 0;
}
"""

async def run_test():
    uri = "ws://localhost:8080/ws/trace"
    print(f"[*] Conectare la {uri}...")
    
    try:
        async with websockets.connect(uri) as ws:
            print("[+] Conectat! Trimit codul C pentru compilare si urmarire GDB...")
            
            # Trimite codul C (sau comanda START conform conventiei din backend)
            payload = {"action": "start", "code": C_CODE}
            await ws.send(json.dumps(payload))
            
            step_count = 0
            while True:
                msg = await ws.recv()
                data = json.loads(msg)
                
                # Daca a aparut o eroare de compilare/runtime
                if data.get("type") == "error":
                    print(f"[-] Eroare de la backend: {data.get('message')}")
                    break
                
                # Afiseaza snapshot-ul primit
                step_count += 1
                line = data.get("line")
                arrays = data.get("arrays", [])
                graph_nodes = data.get("graph", {}).get("nodes", [])
                
                print(f"\n--- PASUL {step_count} (Linia {line}) ---")
                if arrays:
                    for a in arrays:
                        print(f"  [Vector] {a.get('name')}: {a.get('elements')} | Indici activi: {a.get('active_indices')}")
                if graph_nodes:
                    print(f"  [Graf] Noduri alocate ({len(graph_nodes)}):")
                    for node in graph_nodes:
                        print(f"    - Adresa: {node.get('id')} | Valoare: {node.get('fields')} | Activ: {node.get('is_active')}")
                
                # Trimite NEXT daca endpoint-ul asteapta comenzi pas-cu-pas
                # await ws.send(json.dumps({"action": "next"}))
                
                # Daca executia s-a terminat
                if data.get("status") == "finished" or data.get("type") == "end":
                    print("\n[+] Executie finalizata cu succes!")
                    break

    except ConnectionRefusedError:
        print("[-] Nu s-a putut realiza conexiunea. Asigura-te ca Docker ruleaza (docker compose ps).")
    except websockets.exceptions.ConnectionClosedOK:
        print("\n[+] Sesiunea WebSocket a fost inchisa normal de server.")
    except Exception as e:
        print(f"[-] Exceptie: {e}")

if __name__ == "__main__":
    asyncio.run(run_test())
