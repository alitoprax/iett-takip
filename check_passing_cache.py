import json
from server import cache

def run():
    target_code = '133691'
    found_lines = []
    
    with open('/home/ali/proje1/nohup.out', 'r') as f:
        print("Nohup lines count:", len(f.readlines()))
        f.seek(0)
        for line in f:
            if "Global güzergah önbelleği" in line:
                print("Cache completion found in nohup!")
                
    for ck, cv in list(cache.items()):
        if ck.startswith('stations_') and 'data' in cv:
            hat_kodu = ck.replace('stations_', '')
            for direction in ['G', 'D']:
                stops_list = cv['data'].get(direction, [])
                for st in stops_list:
                    if str(st.get('kod', '')) == target_code:
                        found_lines.append(hat_kodu)
                        break
    print("Lines passing through", target_code, ":", set(found_lines))

if __name__ == "__main__":
    run()
